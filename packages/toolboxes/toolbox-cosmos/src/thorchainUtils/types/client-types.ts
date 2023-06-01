import { OfflineDirectSigner } from '@cosmjs/proto-signing';
import { Account as CosmosAccount } from '@cosmjs/stargate';
import { cosmosclient, proto } from '@cosmos-client/core';
import { InlineResponse20075TxResponse } from '@cosmos-client/core/openapi';
import { AssetAmount, AssetEntity } from '@thorswap-lib/swapkit-entities';
import {
  AmountWithBaseDenom,
  Asset,
  Balance,
  ChainId,
  Fees,
  Network,
  Tx,
} from '@thorswap-lib/types';

import { BNBTransaction } from '../../binanceUtils/transaction.js';
import { CosmosSDKClient } from '../../cosmosSdkClient.js';
import { Account } from '../../index.js';
import { TransferParams } from '../../types.js';

export type NodeUrl = {
  node: string;
  rpc: string;
};

export type ClientUrl = Record<Network, NodeUrl>;

export type ChainIds = Record<Network, string>;

export type DepositParam = {
  walletIndex?: number;
  asset?: Asset;
  amount: AmountWithBaseDenom;
  memo: string;
};

export type TxData = Pick<Tx, 'from' | 'to' | 'type'>;

/**
 * Response from `thorchain/constants` endpoint
 */
export type ThorchainConstantsResponse = {
  int_64_values: {
    // We are in fee interested only - ignore all other values
    NativeTransactionFee: number;
  };
};

/**
 * Response of `/cosmos/base/tendermint/v1beta1/node_info`
 * Note: We are interested in `network` (aka chain id) only
 */
export type NodeInfoResponse = {
  default_node_info: {
    network: string;
  };
};

export type BaseCosmosToolboxType = {
  sdk: CosmosSDKClient['sdk'];
  signAndBroadcast: CosmosSDKClient['signAndBroadcast'];
  getAccount: (
    address: string | cosmosclient.PubKey | Uint8Array,
  ) => Promise<proto.cosmos.auth.v1beta1.IBaseAccount>;
  validateAddress: (address: string) => boolean;
  createKeyPair: (phrase: string) => proto.cosmos.crypto.secp256k1.PrivKey;
  getAddressFromMnemonic: (phrase: string) => string;
  getBalance: (address: string, filterAssets?: AssetEntity[] | undefined) => Promise<Balance[]>;
  transfer: (params: TransferParams) => Promise<string>;
  buildSendTxBody?: CosmosSDKClient['buildSendTxBody'];
  getFeeRateFromThorswap?: (chainId: ChainId) => Promise<number | undefined>;
};

export type CommonCosmosToolboxType = {
  getFees: () => Promise<Fees>;
};

export type ThorchainToolboxType = BaseCosmosToolboxType &
  CommonCosmosToolboxType & {
    deposit: (
      params: DepositParam & { from: string; privKey: proto.cosmos.crypto.secp256k1.PrivKey },
    ) => Promise<string>;
    getAccAddress: (address: string) => cosmosclient.AccAddress;
    instanceToProto: (value: any) => proto.google.protobuf.Any;
    createMultisig: (
      pubKeys: string[],
      threshold: number,
    ) => proto.cosmos.crypto.multisig.LegacyAminoPubKey;
    getMultisigAddress: (multisigPubKey: proto.cosmos.crypto.multisig.LegacyAminoPubKey) => string;
    mergeSignatures: (signatures: Uint8Array[]) => Uint8Array;
    exportSignature: (signature: Uint8Array) => string;
    importSignature: (signature: string) => Uint8Array;
    exportMultisigTx: (txBuilder: cosmosclient.TxBuilder) => unknown;
    importMultisigTx: (
      cosmosSdk: cosmosclient.CosmosSDK,
      tx: any,
    ) => Promise<cosmosclient.TxBuilder>;
    broadcastMultisig: (
      cosmosSdk: cosmosclient.CosmosSDK,
      tx: any,
      signatures: string[],
    ) => Promise<InlineResponse20075TxResponse | undefined>;
    loadAddressBalances: (address: string) => Promise<AssetAmount[]>;
  };

export type GaiaToolboxType = Omit<
  BaseCosmosToolboxType,
  'getAccount' | 'getBalance' | 'createKeyPair' | 'signAndBroadcast'
> &
  CommonCosmosToolboxType & {
    getAccount: (address: string) => Promise<CosmosAccount | null>;
    getBalance: (address: string, filterAssets?: AssetEntity[] | undefined) => Promise<Balance[]>;
    getSigner: (phrase: string) => Promise<OfflineDirectSigner>;
  };

export type BinanceToolboxType = Omit<
  BaseCosmosToolboxType,
  'getAccount' | 'createKeyPair' | 'getAddressFromMnemonic'
> &
  CommonCosmosToolboxType & {
    createKeyPair: (phrase: string) => Promise<Uint8Array>;
    getAddressFromMnemonic: (phrase: string) => Promise<string>;
    transfer: (params: TransferParams) => Promise<string>;
    getAccount: (address: string) => Promise<Account>;
    sendRawTransaction: (signedBz: string, sync: boolean) => Promise<any>;
    createTransactionAndSignMsg: (params: TransferParams) => Promise<{
      transaction: BNBTransaction;
      signMsg: {
        inputs: {
          address: string;
          coins: {
            amount: number;
            denom: string;
          }[];
        }[];
        outputs: {
          address: string;
          coins: {
            amount: number;
            denom: string;
          }[];
        }[];
      };
    }>;
  };
