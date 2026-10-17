import { Subscription, BaseSubscription as _BaseSubscription } from './subscription';
import { State, Options, SubscriptionState, ClientEvents, TypedEventEmitter, RpcResult, SubscriptionOptions, MapSubscriptionOptions, MapSubscriptionEvents, BaseSubscriptionEvents, SharedPollSubscriptionOptions, SharedPollSubscriptionEvents, SharedPollTrackItem, HistoryOptions, HistoryResult, PublishResult, PresenceResult, PresenceStatsResult, TransportEndpoint } from './types';
/** Common methods shared by all subscription types. */
type CommonSurface = Pick<_BaseSubscription, 'channel' | 'state' | 'type' | 'subscribe' | 'unsubscribe' | 'ready' | 'presence' | 'presenceStats' | 'setData' | 'deltaStats'>;
/** Common subscription surface — use for mixed-type registries. */
export type BaseSubscription = CommonSurface & TypedEventEmitter<BaseSubscriptionEvents>;
/** Map subscription: publish/remove + narrowed map events. */
export type MapSubscription = CommonSurface & Pick<_BaseSubscription, 'setTagsFilter'> & {
    publish(key: string, data: any): Promise<PublishResult>;
    remove(key: string): Promise<PublishResult>;
} & TypedEventEmitter<MapSubscriptionEvents>;
/** Shared poll subscription: track/untrack + narrowed shared poll events. */
export type SharedPollSubscription = CommonSurface & {
    track(keysOrItems: string[] | SharedPollTrackItem[], signature?: string): void;
    untrack(keys: string[]): void;
    trackedKeys(): Set<string>;
} & TypedEventEmitter<SharedPollSubscriptionEvents>;
export declare class UnauthorizedError extends Error {
    constructor(message: any);
}
declare const Centrifuge_base: new () => TypedEventEmitter<ClientEvents>;
/** Centrifuge is a Centrifuge/Centrifugo bidirectional client. */
export declare class Centrifuge extends Centrifuge_base {
    state: State;
    private _transportIsOpen;
    private _endpoint;
    private _emulation;
    private _transports;
    private _currentTransportIndex;
    private _triedAllTransports;
    private _transportWasOpen;
    private _transport?;
    private _transportId;
    private _deviceWentOffline;
    private _transportClosed;
    private _reconnecting;
    private _reconnectTimeout?;
    private _reconnectAttempts;
    private _client;
    private _session;
    private _node;
    private _subs;
    private _serverSubs;
    private _commandId;
    private _commands;
    private _batching;
    private _refreshRequired;
    private _refreshTimeout?;
    private _callbacks;
    private _token;
    private _data;
    private _dispatchPromise;
    private _serverPing;
    private _serverPingTimeout?;
    private _sendPong;
    private _promises;
    private _promiseId;
    private _networkEventsSet;
    private _debugEnabled;
    private _config;
    protected _codec: any;
    static SubscriptionState: typeof SubscriptionState;
    static State: typeof State;
    static UnauthorizedError: typeof UnauthorizedError;
    /** Constructs Centrifuge client. Call connect() method to start connecting. */
    constructor(endpoint: string | Array<TransportEndpoint>, options?: Partial<Options>);
    /** newSubscription allocates new Subscription to a channel. Since server only allows
     * one subscription per channel per client this method throws if client already has
     * channel subscription in internal registry.
     * */
    newSubscription(channel: string, options?: SubscriptionOptions): Subscription;
    /** newMapSubscription allocates new map Subscription to a channel. Since server only allows
     * one subscription per channel per client this method throws if client already has
     * channel subscription in internal registry.
     *
     * Experimental. Requires Centrifugo >= v6.8.0. API may change in a backwards-incompatible
     * way in subsequent minor releases. */
    newMapSubscription(channel: string, options?: MapSubscriptionOptions): MapSubscription;
    /** Create a map subscription for observing individual connections (clients presence).
     * Each entry has key=clientId and contains full ClientInfo.
     * Use this to track connections per channel.
     * The channel should be the full presence channel name (e.g., "$clients:games").
     *
     * Experimental. Requires Centrifugo >= v6.8.0. API may change in a backwards-incompatible
     * way in subsequent minor releases. */
    newMapClientsSubscription(channel: string, options?: MapSubscriptionOptions): MapSubscription;
    /** Create a map subscription for observing unique users (users presence).
     * Each entry has key=userId (no ClientInfo stored).
     * User entries expire via TTL, providing debounce for quick reconnects.
     * The channel should be the full presence channel name (e.g., "$users:games").
     *
     * Experimental. Requires Centrifugo >= v6.8.0. API may change in a backwards-incompatible
     * way in subsequent minor releases. */
    newMapUsersSubscription(channel: string, options?: MapSubscriptionOptions): MapSubscription;
    /** newSharedPollSubscription allocates a new shared poll Subscription to a channel.
     * Shared poll subscriptions use server-side polling to aggregate interest sets
     * and deliver periodic updates with version tracking. Track items after subscribing
     * using the track() method on the returned Subscription.
     *
     * Experimental. Requires Centrifugo >= v6.8.0. API may change in a backwards-incompatible
     * way in subsequent minor releases. */
    newSharedPollSubscription(channel: string, options?: SharedPollSubscriptionOptions): SharedPollSubscription;
    /** getSubscription returns Subscription if it's registered in the internal
     * registry or null. */
    getSubscription(channel: string): Subscription | null;
    /** Get a map subscription by channel. */
    getMapSubscription(channel: string): MapSubscription | null;
    /** Get a shared poll subscription by channel. */
    getSharedPollSubscription(channel: string): SharedPollSubscription | null;
    /** removeSubscription allows removing Subcription from the internal registry. */
    removeSubscription(sub: Subscription | null): void;
    /** Remove a map subscription. */
    removeMapSubscription(sub: MapSubscription | null): void;
    /** Remove a shared poll subscription. */
    removeSharedPollSubscription(sub: SharedPollSubscription | null): void;
    /** Get a map with all current client-side subscriptions. */
    subscriptions(): Record<string, Subscription>;
    /** Get all map subscriptions. */
    mapSubscriptions(): Record<string, MapSubscription>;
    /** Get all shared poll subscriptions. */
    sharedPollSubscriptions(): Record<string, SharedPollSubscription>;
    /** ready returns a Promise which resolves upon client goes to Connected
     * state and rejects in case of client goes to Disconnected or Failed state.
     * Users can provide optional timeout in milliseconds. */
    ready(timeout?: number): Promise<void>;
    /** connect to a server. */
    connect(): void;
    /** disconnect from a server. */
    disconnect(): void;
    /** setToken allows setting connection token. Or resetting used token to be empty.  */
    setToken(token: string): void;
    /** setData allows setting connection data. This only affects the next connection attempt,
     * not the current one. Note that if getData callback is configured, it will override
     * this value during reconnects. */
    setData(data: any): void;
    /** setHeaders allows setting connection emulated headers. */
    setHeaders(headers: {
        [key: string]: string;
    }): void;
    /** send asynchronous data to a server (without any response from a server
     * expected, see rpc method if you need response). */
    send(data: any): Promise<void>;
    /** rpc to a server - i.e. a call which waits for a response with data. */
    rpc(method: string, data: any): Promise<RpcResult>;
    /** publish data to a channel. */
    publish(channel: string, data: any): Promise<PublishResult>;
    /** Publish data to a key in a map channel without holding a MapSubscription.
     * Use this when you need to write to a map channel from outside a subscription
     * context (e.g. a standalone publisher). When you already hold a MapSubscription,
     * prefer `sub.publish(key, data)` instead — it enforces the method-call guard and
     * applies debounce configuration. */
    mapPublish(channel: string, key: string, data: any): Promise<PublishResult>;
    /** Remove a key from a map channel without holding a MapSubscription.
     * Use this when you need to remove a key from outside a subscription context.
     * When you already hold a MapSubscription, prefer `sub.remove(key)` instead —
     * it enforces the method-call guard and cancels any pending debounced publish. */
    mapRemove(channel: string, key: string): Promise<PublishResult>;
    /** history for a channel. By default it does not return publications (only current
     *  StreamPosition data) – provide an explicit limit > 0 to load publications.*/
    history(channel: string, options?: HistoryOptions): Promise<HistoryResult>;
    /** presence for a channel. */
    presence(channel: string): Promise<PresenceResult>;
    presenceStats(channel: string): Promise<PresenceStatsResult>;
    /** start command batching (collect into temporary buffer without sending to a server)
     * until stopBatching called.*/
    startBatching(): void;
    /** stop batching commands and flush collected commands to the
     * network (all in one request/frame).*/
    stopBatching(): void;
    private _debug;
    private _codecName;
    private _configure;
    private _setState;
    private _isDisconnected;
    private _isConnecting;
    private _isConnected;
    private _nextCommandId;
    private _setNetworkEvents;
    private _getReconnectDelay;
    private _clearOutgoingRequests;
    private _clearConnectedState;
    private _handleWriteError;
    private _transportSendCommands;
    private _initializeTransport;
    private _sendConnect;
    private _startReconnecting;
    private _handleGetDataError;
    private _connectError;
    private _scheduleReconnect;
    private _constructConnectCommand;
    private _getHistoryRequest;
    private _methodCall;
    private _callPromise;
    private _dataReceived;
    private _dispatchSynchronized;
    private _dispatchReply;
    private _call;
    private _startConnecting;
    private _disconnect;
    private _failUnauthorized;
    private _getToken;
    private _refresh;
    private _refreshError;
    private _getRefreshRetryDelay;
    private _refreshResponse;
    private _removeSubscription;
    protected _unsubscribe(sub: _BaseSubscription): Promise<void>;
    private _getSub;
    private _isServerSub;
    private _sendSubscribeCommands;
    private _connectResponse;
    private _processServerSubs;
    private _clearRefreshTimeout;
    private _clearReconnectTimeout;
    private _clearServerPingTimeout;
    private _waitServerPing;
    private _getSubscribeContext;
    private _handleReply;
    private _handleJoin;
    private _handleLeave;
    private _handleUnsubscribe;
    private _handleSubscribe;
    private _handleDisconnect;
    private _getPublicationContext;
    private _getJoinLeaveContext;
    private _handlePublication;
    private _handleMessage;
    private _handleServerPing;
    private _handlePush;
    private _flush;
    private _createErrorObject;
    private _registerCall;
    private _addCommand;
    private _nextPromiseId;
    private _nextTransportId;
    private _resolvePromises;
    private _rejectPromises;
}
export {};
