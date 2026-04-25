export const UPBIT_PRIVATE_BASE_URL = "https://api.upbit.com";
export const UPBIT_SPOT_MARKETS = ["KRW-BTC", "KRW-ETH"] as const;
export const MANAGED_SPOT_ASSETS = ["KRW", "BTC", "ETH"] as const;

export const UPBIT_EXCHANGE_PERMISSION_GROUPS = {
  VIEW_ACCOUNTS: "asset:view",
  VIEW_ORDERS: "order:view",
  MAKE_ORDERS: "order:write",
} as const;

export type UpbitSpotMarket = (typeof UPBIT_SPOT_MARKETS)[number];
export type ManagedSpotAsset = (typeof MANAGED_SPOT_ASSETS)[number];
export type DecimalString = string & { readonly __brand: "DecimalString" };
export type Iso8601String = string & { readonly __brand: "Iso8601String" };
export type UuidString = string & { readonly __brand: "UuidString" };
export type UpbitOrderIdentifier = string & {
  readonly __brand: "UpbitOrderIdentifier";
};
export type UpbitPermissionGroup =
  (typeof UPBIT_EXCHANGE_PERMISSION_GROUPS)[keyof typeof UPBIT_EXCHANGE_PERMISSION_GROUPS];
export type UpbitRestMethod = "GET" | "POST" | "DELETE";
export type UpbitOrderSide = "bid" | "ask";
export type UpbitOrderType = "limit" | "price" | "market" | "best";
export type UpbitTimeInForce = "ioc" | "fok" | "post_only";
export type UpbitSmpType = "cancel_maker" | "cancel_taker" | "reduce";
export type UpbitOrderState = "wait" | "watch" | "done" | "cancel";
export type UpbitQueryHashAlgorithm = "SHA512";

export interface UpbitPrivateCredentials {
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface UpbitCanonicalQuery {
  readonly raw: string;
}

export interface UpbitAuthRequest {
  readonly credentials: UpbitPrivateCredentials;
  readonly permission: UpbitPermissionGroup;
  readonly method: UpbitRestMethod;
  readonly path: `/v1/${string}`;
  readonly queryHashSource?: UpbitCanonicalQuery;
  readonly nonce?: string;
}

export interface UpbitJwtPayload {
  readonly access_key: string;
  readonly nonce: string;
  readonly query_hash?: string;
  readonly query_hash_alg?: UpbitQueryHashAlgorithm;
}

export interface UpbitSignedAuth {
  readonly authorizationHeader: `Bearer ${string}`;
  readonly payload: UpbitJwtPayload;
}

export interface UpbitPrivateAuthSigner {
  sign(request: UpbitAuthRequest): Promise<UpbitSignedAuth>;
}

export interface UpbitApiError {
  readonly status: number;
  readonly name: string;
  readonly message: string;
  readonly permission?: UpbitPermissionGroup;
}

export interface UpbitBalance {
  readonly currency: string;
  readonly balance: DecimalString;
  readonly locked: DecimalString;
  readonly avg_buy_price: DecimalString;
  readonly avg_buy_price_modified: boolean;
  readonly unit_currency: string;
}

export interface UpbitTickerSnapshot {
  readonly market: UpbitSpotMarket;
  readonly trade_price: number;
  readonly trade_timestamp: number;
}

export interface UpbitOrderConstraint {
  readonly currency: string;
  readonly price_unit: DecimalString;
  readonly min_total: number;
}

export interface UpbitOrderChanceMarket {
  readonly id: UpbitSpotMarket;
  readonly order_sides: readonly UpbitOrderSide[];
  readonly order_types?: readonly UpbitOrderType[];
  readonly bid_types: readonly UpbitOrderType[];
  readonly ask_types: readonly UpbitOrderType[];
  readonly bid: UpbitOrderConstraint;
  readonly ask: UpbitOrderConstraint;
  readonly max_total: DecimalString;
  readonly state: string;
}

export interface UpbitOrderChance {
  readonly bid_fee: DecimalString;
  readonly ask_fee: DecimalString;
  readonly maker_bid_fee: DecimalString;
  readonly maker_ask_fee: DecimalString;
  readonly market: UpbitOrderChanceMarket;
  readonly bid_account: UpbitBalance;
  readonly ask_account: UpbitBalance;
}

export interface UpbitTradeFill {
  readonly market?: UpbitSpotMarket;
  readonly uuid?: UuidString;
  readonly price: DecimalString;
  readonly volume: DecimalString;
  readonly funds?: DecimalString;
  readonly side?: UpbitOrderSide;
  readonly created_at?: Iso8601String;
}

export interface UpbitOrderSnapshot {
  readonly uuid: UuidString;
  readonly side: UpbitOrderSide;
  readonly ord_type: UpbitOrderType;
  readonly price: DecimalString | null;
  readonly state: UpbitOrderState;
  readonly market: UpbitSpotMarket;
  readonly created_at: Iso8601String;
  readonly volume: DecimalString | null;
  readonly remaining_volume: DecimalString;
  readonly reserved_fee: DecimalString;
  readonly remaining_fee: DecimalString;
  readonly paid_fee: DecimalString;
  readonly locked: DecimalString;
  readonly executed_volume: DecimalString;
  readonly executed_funds: DecimalString;
  readonly trades_count: number;
  readonly trades?: readonly UpbitTradeFill[];
  readonly identifier?: UpbitOrderIdentifier;
  readonly time_in_force?: UpbitTimeInForce | null;
  readonly smp_type?: UpbitSmpType | null;
  readonly prevented_volume?: DecimalString | null;
  readonly prevented_locked?: DecimalString | null;
}

export interface UpbitTestOrderReceipt extends UpbitOrderSnapshot {
  readonly validation_only: true;
  readonly reusable_reference: false;
}

export interface UpbitCreatedOrderReceipt extends UpbitOrderSnapshot {
  readonly validation_only?: false;
}

export type UpbitOrderReference =
  | {
      readonly uuid: UuidString;
      readonly identifier?: UpbitOrderIdentifier;
    }
  | {
      readonly uuid?: never;
      readonly identifier: UpbitOrderIdentifier;
    };

export interface UpbitGetBalancesRequest {
  readonly permission: typeof UPBIT_EXCHANGE_PERMISSION_GROUPS.VIEW_ACCOUNTS;
}

export interface UpbitGetOrderChanceRequest {
  readonly permission: typeof UPBIT_EXCHANGE_PERMISSION_GROUPS.VIEW_ORDERS;
  readonly market: UpbitSpotMarket;
}

export interface UpbitBaseOrderRequest {
  readonly market: UpbitSpotMarket;
  readonly identifier?: UpbitOrderIdentifier;
  readonly smp_type?: UpbitSmpType;
}

export interface UpbitLimitOrderRequest extends UpbitBaseOrderRequest {
  readonly side: UpbitOrderSide;
  readonly ord_type: "limit";
  readonly volume: DecimalString;
  readonly price: DecimalString;
  readonly time_in_force?: UpbitTimeInForce;
}

export interface UpbitMarketBuyOrderRequest extends UpbitBaseOrderRequest {
  readonly side: "bid";
  readonly ord_type: "price";
  readonly price: DecimalString;
  readonly volume?: never;
  readonly time_in_force?: never;
}

export interface UpbitMarketSellOrderRequest extends UpbitBaseOrderRequest {
  readonly side: "ask";
  readonly ord_type: "market";
  readonly volume: DecimalString;
  readonly price?: never;
  readonly time_in_force?: never;
}

export interface UpbitBestBuyOrderRequest extends UpbitBaseOrderRequest {
  readonly side: "bid";
  readonly ord_type: "best";
  readonly price: DecimalString;
  readonly volume?: never;
  readonly time_in_force: Extract<UpbitTimeInForce, "ioc" | "fok">;
}

export interface UpbitBestSellOrderRequest extends UpbitBaseOrderRequest {
  readonly side: "ask";
  readonly ord_type: "best";
  readonly volume: DecimalString;
  readonly price?: never;
  readonly time_in_force: Extract<UpbitTimeInForce, "ioc" | "fok">;
}

export type UpbitOrderRequest =
  | UpbitLimitOrderRequest
  | UpbitMarketBuyOrderRequest
  | UpbitMarketSellOrderRequest
  | UpbitBestBuyOrderRequest
  | UpbitBestSellOrderRequest;

export interface UpbitTestOrderRequest {
  readonly permission: typeof UPBIT_EXCHANGE_PERMISSION_GROUPS.MAKE_ORDERS;
  readonly order: UpbitOrderRequest;
}

export interface UpbitCreateOrderRequest {
  readonly permission: typeof UPBIT_EXCHANGE_PERMISSION_GROUPS.MAKE_ORDERS;
  readonly order: UpbitOrderRequest;
}

export interface UpbitCancelOrderRequest {
  readonly permission: typeof UPBIT_EXCHANGE_PERMISSION_GROUPS.MAKE_ORDERS;
  readonly target: UpbitOrderReference;
}

export interface UpbitGetOrderRequest {
  readonly permission: typeof UPBIT_EXCHANGE_PERMISSION_GROUPS.VIEW_ORDERS;
  readonly target: UpbitOrderReference;
}

export interface UpbitListOpenOrdersRequest {
  readonly permission: typeof UPBIT_EXCHANGE_PERMISSION_GROUPS.VIEW_ORDERS;
  readonly market?: UpbitSpotMarket;
  readonly states?: readonly Extract<UpbitOrderState, "wait" | "watch">[];
  readonly page?: number;
  readonly limit?: number;
  readonly order_by?: "asc" | "desc";
}

export interface UpbitListClosedOrdersRequest {
  readonly permission: typeof UPBIT_EXCHANGE_PERMISSION_GROUPS.VIEW_ORDERS;
  readonly market?: UpbitSpotMarket;
  readonly states?: readonly Extract<UpbitOrderState, "done" | "cancel">[];
  readonly start_time?: number;
  readonly end_time?: number;
  readonly page?: number;
  readonly limit?: number;
  readonly order_by?: "asc" | "desc";
}

export interface UpbitPrivateExchangeClient {
  getBalances(request: UpbitGetBalancesRequest): Promise<readonly UpbitBalance[]>;
  getOrderChance(request: UpbitGetOrderChanceRequest): Promise<UpbitOrderChance>;
  testOrder(request: UpbitTestOrderRequest): Promise<UpbitTestOrderReceipt>;
  createOrder(request: UpbitCreateOrderRequest): Promise<UpbitCreatedOrderReceipt>;
  cancelOrder(request: UpbitCancelOrderRequest): Promise<UpbitOrderSnapshot>;
  getOrder(request: UpbitGetOrderRequest): Promise<UpbitOrderSnapshot>;
  listOpenOrders(request: UpbitListOpenOrdersRequest): Promise<readonly UpbitOrderSnapshot[]>;
  listClosedOrders(request: UpbitListClosedOrdersRequest): Promise<readonly UpbitOrderSnapshot[]>;
}

export interface UpbitPublicQuotationClient {
  getTickers(markets: readonly UpbitSpotMarket[]): Promise<readonly UpbitTickerSnapshot[]>;
}
