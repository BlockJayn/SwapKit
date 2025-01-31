import { type QuoteRoute, SwapKitApi, type SwapWithRouteParams } from "@swapkit/api";
import {
  AGG_SWAP,
  ApproveMode,
  type ApproveReturnType,
  AssetValue,
  type BaseWallet,
  Chain,
  ChainToChainId,
  type CoreTxParams,
  type EVMChain,
  type ErrorKeys,
  FeeOption,
  MemoType,
  SWAP_IN,
  SWAP_OUT,
  SwapKitError,
  SwapKitNumber,
  type SwapParams,
  TCAvalancheDepositABI,
  TCBscDepositABI,
  TCEthereumVaultAbi,
  type ThornameRegisterParam,
  gasFeeMultiplier,
  getMemoFor,
  getMinAmountByChain,
  wrapWithThrow,
} from "@swapkit/helpers";
import type { CosmosWallets, ThorchainWallets } from "@swapkit/toolbox-cosmos";
import type { EVMWallets } from "@swapkit/toolbox-evm";
import type { SubstrateWallets } from "@swapkit/toolbox-substrate";
import type { UTXOWallets } from "@swapkit/toolbox-utxo";
import {
  type AGG_CONTRACT_ADDRESS,
  lowercasedContractAbiMapping,
} from "./aggregator/contracts/index.ts";
import { getSwapInParams } from "./aggregator/getSwapParams.ts";

type Wallet = BaseWallet<
  EVMWallets & CosmosWallets & ThorchainWallets & UTXOWallets & SubstrateWallets
>;

const validateAddressType = ({
  chain,
  address,
}: {
  chain: Chain;
  address?: string;
}) => {
  if (!address) return false;

  switch (chain) {
    case Chain.Bitcoin:
      // filter out taproot addresses
      return !address.startsWith("bc1p");
    default:
      return true;
  }
};

const getAddress = (wallet: Wallet, chain: Chain) => wallet[chain]?.address || "";

const prepareTxParams = (
  wallets: Wallet,
  { assetValue, ...restTxParams }: CoreTxParams & { router?: string },
) => ({
  ...restTxParams,
  memo: restTxParams.memo || "",
  from: getAddress(wallets, assetValue.chain),
  assetValue,
});

const plugin = ({ wallets, stagenet = false }: { wallets: Wallet; stagenet?: boolean }) => {
  /**
   * @Private
   * Wallet interaction helpers
   */
  async function approve<T extends ApproveMode>({
    assetValue,
    type = "checkOnly" as T,
    contractAddress,
  }: {
    type: T;
    assetValue: AssetValue;
    contractAddress?: string;
  }) {
    const { address, chain, isGasAsset, isSynthetic } = assetValue;
    const isEVMChain = [Chain.Ethereum, Chain.Avalanche, Chain.BinanceSmartChain].includes(chain);
    const isNativeEVM = isEVMChain && isGasAsset;

    if (isNativeEVM || !isEVMChain || isSynthetic) {
      return Promise.resolve(type === "checkOnly" ? true : "approved") as ApproveReturnType<T>;
    }

    const walletMethods =
      wallets[chain as Chain.Ethereum | Chain.BinanceSmartChain | Chain.Avalanche];

    const walletAction = type === "checkOnly" ? walletMethods?.isApproved : walletMethods?.approve;
    if (!walletAction) {
      throw new SwapKitError("core_wallet_connection_not_found");
    }

    const from = walletMethods?.address;

    if (!(address && from)) {
      throw new SwapKitError("core_approve_asset_address_or_from_not_found");
    }

    const spenderAddress =
      contractAddress || ((await getInboundDataByChain(chain)).router as string);

    return walletAction({
      amount: assetValue.getBaseValue("bigint"),
      assetAddress: address,
      from,
      spenderAddress,
    });
  }

  async function transfer({
    memo,
    assetValue,
  }: {
    assetValue: AssetValue;
    memo: string;
  }) {
    const mimir = await SwapKitApi.getMimirInfo({ stagenet });

    // check if trading is halted or not
    if (mimir.HALTCHAINGLOBAL >= 1 || mimir.HALTTHORCHAIN >= 1) {
      throw new SwapKitError("core_chain_halted");
    }

    return deposit({ assetValue, recipient: "", memo });
  }

  async function depositToPool({
    assetValue,
    memo,
    feeOptionKey = FeeOption.Fast,
  }: {
    assetValue: AssetValue;
    memo: string;
    feeOptionKey?: FeeOption;
  }) {
    const {
      gas_rate = "0",
      router,
      address: poolAddress,
    } = await getInboundDataByChain(assetValue.chain);

    return deposit({
      assetValue,
      recipient: poolAddress,
      memo,
      router,
      feeRate: Number.parseInt(gas_rate) * gasFeeMultiplier[feeOptionKey],
    });
  }

  function registerThorname({
    assetValue,
    ...param
  }: ThornameRegisterParam & { assetValue: AssetValue }) {
    return transfer({ assetValue, memo: getMemoFor(MemoType.THORNAME_REGISTER, param) });
  }

  function nodeAction({
    type,
    assetValue,
    address,
  }: { address: string } & (
    | { type: "bond" | "unbond"; assetValue: AssetValue }
    | { type: "leave"; assetValue?: undefined }
  )) {
    const memoType =
      type === "bond" ? MemoType.BOND : type === "unbond" ? MemoType.UNBOND : MemoType.LEAVE;
    const memo = getMemoFor(memoType, {
      address,
      unbondAmount: type === "unbond" ? assetValue.getBaseValue("number") : undefined,
    });
    const assetToTransfer = type === "bond" ? assetValue : getMinAmountByChain(Chain.THORChain);

    return transfer({ memo, assetValue: assetToTransfer });
  }

  function loan({
    assetValue,
    memo,
    minAmount,
    type,
  }: {
    assetValue: AssetValue;
    memo?: string;
    minAmount: AssetValue;
    type: "open" | "close";
  }) {
    return depositToPool({
      assetValue,
      memo:
        memo ||
        getMemoFor(type === "open" ? MemoType.OPEN_LOAN : MemoType.CLOSE_LOAN, {
          asset: assetValue.toString(),
          minAmount: minAmount.toString(),
          address: getAddress(wallets, assetValue.chain),
        }),
    });
  }

  function savings({
    assetValue,
    memo,
    percent,
    type,
  }: { assetValue: AssetValue; memo?: string } & (
    | { type: "add"; percent?: undefined }
    | { type: "withdraw"; percent: number }
  )) {
    const memoType = type === "add" ? MemoType.DEPOSIT : MemoType.WITHDRAW;
    const memoString =
      memo ||
      getMemoFor(memoType, {
        ticker: assetValue.ticker,
        symbol: assetValue.symbol,
        chain: assetValue.chain,
        singleSide: true,
        basisPoints: percent ? Math.min(10000, Math.round(percent * 100)) : undefined,
      });

    const value =
      memoType === MemoType.DEPOSIT ? assetValue : getMinAmountByChain(assetValue.chain);

    return depositToPool({ memo: memoString, assetValue: value });
  }

  function withdraw({
    memo,
    assetValue,
    percent,
    from,
    to,
  }: {
    memo?: string;
    assetValue: AssetValue;
    percent: number;
    from: "sym" | "rune" | "asset";
    to: "sym" | "rune" | "asset";
  }) {
    const targetAsset =
      to === "rune" && from !== "rune"
        ? AssetValue.fromChainOrSignature(Chain.THORChain)
        : (from === "sym" && to === "sym") || from === "rune" || from === "asset"
          ? undefined
          : assetValue;

    const value = getMinAmountByChain(from === "asset" ? assetValue.chain : Chain.THORChain);
    const memoString =
      memo ||
      getMemoFor(MemoType.WITHDRAW, {
        symbol: assetValue.symbol,
        chain: assetValue.chain,
        ticker: assetValue.ticker,
        basisPoints: Math.min(10000, Math.round(percent * 100)),
        targetAssetString: targetAsset?.toString(),
        singleSide: false,
      });

    return depositToPool({ assetValue: value, memo: memoString });
  }

  function addLiquidityPart({
    assetValue,
    poolAddress,
    address,
    symmetric,
  }: {
    assetValue: AssetValue;
    address?: string;
    poolAddress: string;
    symmetric: boolean;
  }) {
    if (symmetric && !address) {
      throw new SwapKitError("core_transaction_add_liquidity_invalid_params");
    }
    const memo = getMemoFor(MemoType.DEPOSIT, {
      chain: poolAddress.split(".")[0] as Chain,
      symbol: poolAddress.split(".")[1] as string,
      address: symmetric ? address : "",
    });

    return depositToPool({ assetValue, memo });
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: TODO: Refactor
  async function addLiquidity({
    runeAssetValue,
    assetValue,
    runeAddr,
    assetAddr,
    isPendingSymmAsset,
    mode = "sym",
  }: {
    runeAssetValue: AssetValue;
    assetValue: AssetValue;
    isPendingSymmAsset?: boolean;
    runeAddr?: string;
    assetAddr?: string;
    mode?: "sym" | "rune" | "asset";
  }) {
    const { chain, symbol } = assetValue;
    const isSym = mode === "sym";
    const runeTransfer = runeAssetValue?.gt(0) && (isSym || mode === "rune");
    const assetTransfer = assetValue?.gt(0) && (isSym || mode === "asset");
    const includeRuneAddress = isPendingSymmAsset || runeTransfer;
    const runeAddress = includeRuneAddress ? runeAddr || getAddress(wallets, Chain.THORChain) : "";
    const assetAddress = isSym || mode === "asset" ? assetAddr || getAddress(wallets, chain) : "";

    if (!(runeTransfer || assetTransfer)) {
      throw new SwapKitError("core_transaction_add_liquidity_invalid_params");
    }
    if (includeRuneAddress && !runeAddress) {
      throw new SwapKitError("core_transaction_add_liquidity_no_rune_address");
    }

    const runeTx =
      runeTransfer && runeAssetValue
        ? await wrapWithThrow(() => {
            return depositToPool({
              assetValue: runeAssetValue,
              memo: getMemoFor(MemoType.DEPOSIT, { chain, symbol, address: assetAddress }),
            });
          }, "core_transaction_add_liquidity_rune_error")
        : undefined;

    const assetTx =
      assetTransfer && assetValue
        ? await wrapWithThrow(() => {
            return depositToPool({
              assetValue,
              memo: getMemoFor(MemoType.DEPOSIT, { chain, symbol, address: runeAddress }),
            });
          }, "core_transaction_add_liquidity_asset_error")
        : undefined;

    return { runeTx, assetTx };
  }

  async function createLiquidity({
    runeAssetValue,
    assetValue,
  }: {
    runeAssetValue: AssetValue;
    assetValue: AssetValue;
  }) {
    if (runeAssetValue.lte(0) || assetValue.lte(0)) {
      throw new SwapKitError("core_transaction_create_liquidity_invalid_params");
    }

    const assetAddress = getAddress(wallets, assetValue.chain);
    const runeAddress = getAddress(wallets, Chain.THORChain);

    const runeTx = wrapWithThrow(() => {
      return depositToPool({
        assetValue: runeAssetValue,
        memo: getMemoFor(MemoType.DEPOSIT, { ...assetValue, address: assetAddress }),
      });
    }, "core_transaction_create_liquidity_rune_error");

    const assetTx = wrapWithThrow(() => {
      return depositToPool({
        assetValue,
        memo: getMemoFor(MemoType.DEPOSIT, { ...assetValue, address: runeAddress }),
      });
    }, "core_transaction_create_liquidity_asset_error");

    return { runeTx, assetTx };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <explanation>
  async function swap(swapParams: SwapParams<"thorchain"> | SwapWithRouteParams) {
    if (!("route" in swapParams)) throw new SwapKitError("core_swap_invalid_params");

    const route = swapParams.route as QuoteRoute;

    const { streamSwap, recipient, feeOptionKey } = swapParams as SwapWithRouteParams;
    const {
      meta: { quoteMode },
      //   evmTransactionDetails: contractCallParams,
    } = route;
    const evmChain = quoteMode.startsWith("ERC20-")
      ? Chain.Ethereum
      : quoteMode.startsWith("ARC20-")
        ? Chain.Avalanche
        : quoteMode.startsWith("BEP20-")
          ? Chain.BinanceSmartChain
          : undefined;

    if (!route.complete) throw new SwapKitError("core_swap_route_not_complete");

    // TODO enable when BE is ready
    //   if (contractCallParams && evmChain) {
    //     const walletMethods = this.connectedWallets[evmChain];

    //     if (!walletMethods?.call) {
    //       throw new SwapKitError('core_wallet_connection_not_found');
    //     }

    //     const { contractAddress, contractMethod, contractParams, contractParamsStreaming } =
    //       contractCallParams;

    //     if (!(streamSwap ? contractParamsStreaming : contractParams)) {
    //       throw new SwapKitError('core_swap_route_transaction_not_found');
    //     }

    //     return await walletMethods.call<string>({
    //       contractAddress,
    //       abi: lowercasedContractAbiMapping[contractAddress.toLowerCase()],
    //       funcName: contractMethod,
    //       funcParams: streamSwap ? contractParamsStreaming : contractParams,
    //     });
    //   }

    if (AGG_SWAP.includes(quoteMode) && evmChain) {
      const walletMethods = wallets[evmChain];

      if (!walletMethods?.sendTransaction) {
        throw new SwapKitError("core_wallet_connection_not_found");
      }

      const transaction = streamSwap ? route?.streamingSwap?.transaction : route?.transaction;

      if (!transaction) {
        throw new SwapKitError("core_swap_route_transaction_not_found");
      }

      const { data, from, to, value } = route.transaction;
      const params = {
        data,
        from,
        to: to.toLowerCase(),
        chainId: BigInt(ChainToChainId[evmChain]),
        value: value ? BigInt(value) : 0n,
      };

      return walletMethods.sendTransaction(
        params,
        feeOptionKey || FeeOption.Average,
      ) as Promise<string>;
    }

    if (SWAP_OUT.includes(quoteMode)) {
      if (!route.calldata.fromAsset) {
        throw new SwapKitError("core_swap_asset_not_recognized");
      }

      const asset = await AssetValue.fromString(route.calldata.fromAsset);
      if (!asset) {
        throw new SwapKitError("core_swap_asset_not_recognized");
      }

      const { address: recipient } = await getInboundDataByChain(asset.chain);
      const {
        contract: router,
        calldata: { expiration, amountIn, memo, memoStreamingSwap },
      } = route;

      const assetValue = asset.add(SwapKitNumber.fromBigInt(BigInt(amountIn), asset.decimal));
      const swapMemo = (streamSwap ? memoStreamingSwap || memo : memo) as string;

      return deposit({
        expiration,
        assetValue,
        memo: swapMemo,
        feeOptionKey,
        router,
        recipient,
      });
    }

    if (SWAP_IN.includes(quoteMode) && evmChain) {
      const { calldata, contract: contractAddress } = route;
      if (!contractAddress) {
        throw new SwapKitError("core_swap_contract_not_found");
      }

      const walletMethods = wallets[evmChain];
      const from = getAddress(wallets, evmChain);

      if (!from) {
        throw new SwapKitError("core_wallet_connection_not_found");
      }

      const { getProvider, toChecksumAddress } = await import("@swapkit/toolbox-evm");
      const provider = getProvider(evmChain);
      const abi = lowercasedContractAbiMapping[contractAddress.toLowerCase()];

      if (!abi) {
        throw new SwapKitError("core_swap_contract_not_supported", { contractAddress });
      }

      const contract = walletMethods.createContract?.(contractAddress, abi, provider);

      const tx = await contract.getFunction("swapIn").populateTransaction(
        ...getSwapInParams({
          streamSwap,
          toChecksumAddress,
          contractAddress: contractAddress as AGG_CONTRACT_ADDRESS,
          recipient,
          calldata,
        }),
        { from },
      );

      return walletMethods.sendTransaction(
        tx,
        feeOptionKey || FeeOption.Average,
      ) as Promise<string>;
    }

    throw new SwapKitError("core_swap_quote_mode_not_supported", { quoteMode });
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: TODO refactor
  async function deposit({
    assetValue,
    recipient,
    router,
    ...rest
  }: CoreTxParams & { router?: string }) {
    const { chain, symbol, ticker } = assetValue;

    const walletInstance = wallets[chain];
    if (!walletInstance) {
      throw new SwapKitError("core_wallet_connection_not_found");
    }

    const isAddressValidated = validateAddressType({ address: walletInstance?.address, chain });
    if (!isAddressValidated) {
      throw new SwapKitError("core_transaction_invalid_sender_address");
    }

    const params = prepareTxParams(wallets, { assetValue, recipient, router, ...rest });

    try {
      switch (chain) {
        case Chain.THORChain:
        case Chain.Maya: {
          const wallet = wallets[chain];
          const tx = await (recipient === "" ? wallet.deposit(params) : wallet.transfer(params));
          return tx;
        }

        case Chain.Ethereum:
        case Chain.BinanceSmartChain:
        case Chain.Avalanche: {
          const wallet = wallets[chain];
          const { getChecksumAddressFromAsset } = await import("@swapkit/toolbox-evm");

          const abi =
            chain === Chain.Avalanche
              ? TCAvalancheDepositABI
              : chain === Chain.BinanceSmartChain
                ? TCBscDepositABI
                : TCEthereumVaultAbi;

          const tx = await wallet.call({
            abi,
            contractAddress:
              router || ((await getInboundDataByChain(chain as EVMChain)).router as string),
            funcName: "depositWithExpiry",
            funcParams: [
              recipient,
              getChecksumAddressFromAsset({ chain, symbol, ticker }, chain),
              assetValue.getBaseValue("string"),
              params.memo,
              rest.expiration ||
                Number.parseInt(`${(new Date().getTime() + 15 * 60 * 1000) / 1000}`),
            ],
            txOverrides: {
              from: params.from,
              value: assetValue.isGasAsset ? assetValue.getBaseValue("bigint") : undefined,
            },
          });

          return tx as string;
        }

        default: {
          if (walletInstance) {
            return walletInstance.transfer(params) as Promise<string>;
          }

          throw new SwapKitError("core_wallet_connection_not_found");
        }
      }
    } catch (error) {
      const errorMessage =
        // @ts-expect-error Fine to use error as string
        typeof error === "string" ? error.toLowerCase() : error?.message.toLowerCase();
      const isInsufficientFunds = errorMessage?.includes("insufficient funds");
      const isGas = errorMessage?.includes("gas");
      const isServer = errorMessage?.includes("server");
      const isUserRejected = errorMessage?.includes("user rejected");
      const errorKey: ErrorKeys = isInsufficientFunds
        ? "core_transaction_deposit_insufficient_funds_error"
        : isGas
          ? "core_transaction_deposit_gas_error"
          : isServer
            ? "core_transaction_deposit_server_error"
            : isUserRejected
              ? "core_transaction_user_rejected"
              : "core_transaction_deposit_error";

      throw new SwapKitError(errorKey, error);
    }
  }

  async function getInboundDataByChain(chain: Chain) {
    switch (chain) {
      case Chain.Maya:
      case Chain.THORChain:
        return { gas_rate: "0", router: "", address: "", halted: false, chain };

      default: {
        const inboundData = await SwapKitApi.getInboundAddresses({ stagenet });
        const chainAddressData = inboundData.find((item) => item.chain === chain);

        if (!chainAddressData) throw new SwapKitError("core_inbound_data_not_found");
        if (chainAddressData?.halted) throw new SwapKitError("core_chain_halted");

        return chainAddressData;
      }
    }
  }

  function approveAssetValue(assetValue: AssetValue, contractAddress?: string) {
    return approve({ assetValue, contractAddress, type: ApproveMode.Approve });
  }

  function isAssetValueApproved(assetValue: AssetValue, contractAddress?: string) {
    return approve({ assetValue, contractAddress, type: ApproveMode.CheckOnly });
  }

  return {
    swap,
    addLiquidity,
    deposit,
    getInboundDataByChain,
    loan,
    withdraw,
    savings,
    registerThorname,
    createLiquidity,
    addLiquidityPart,
    nodeAction,
    approveAssetValue,
    isAssetValueApproved,
  };
};

export const ThorchainPlugin = { thorchain: { plugin } } as const;

/**
 * @deprecated Use import { ThorchainPlugin } from "@swapkit/thorchain" instead
 */
export const ThorchainProvider = ThorchainPlugin;
