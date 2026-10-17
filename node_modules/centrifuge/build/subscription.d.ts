import { Centrifuge } from './centrifuge';
import { HistoryOptions, HistoryResult, PresenceResult, PresenceStatsResult, PublishResult, InternalSubscriptionEvents, InternalSubscriptionOptions, SubscriptionState, TypedEventEmitter, FilterNode, DeltaStats, SharedPollTrackItem, SharedPollSignatureContext, SharedPollSignatureResult } from './types';
declare const BaseSubscription_base: new () => TypedEventEmitter<InternalSubscriptionEvents>;
/** Base subscription to a channel — all subscription logic lives here. */
export declare class BaseSubscription extends BaseSubscription_base {
    channel: string;
    state: SubscriptionState;
    readonly type: string;
    protected _centrifuge: Centrifuge;
    private _promises;
    private _resubscribeTimeout?;
    private _refreshTimeout?;
    private _getToken;
    private _minResubscribeDelay;
    private _maxResubscribeDelay;
    private _recover;
    private _offset;
    private _epoch;
    private _id;
    private _resubscribeAttempts;
    private _promiseId;
    private _delta;
    private _delta_negotiated;
    private _tagsFilter;
    private _token;
    private _data;
    private _getData;
    private _recoverable;
    private _positioned;
    private _joinLeave;
    private _inflight;
    private _prevValueMap;
    private _unsubPromise;
    private _deltaNumPubs;
    private _deltaNumFull;
    private _deltaNumDelta;
    private _deltaBytesReceived;
    private _deltaBytesDecoded;
    private _getState;
    private _map;
    private _mapPresenceType;
    private _mapPhase;
    private _mapStateBuffer;
    private _mapStreamBuffer;
    private _mapCursor;
    private _mapPageSize;
    private _mapUnrecoverableStrategy;
    protected _debounceMs: number;
    private _debouncePending;
    private _sharedPoll;
    private _sharedPollEpoch;
    protected _sharedPollTrackedItems: Map<string, number>;
    protected _sharedPollGetSignature: null | ((ctx: SharedPollSignatureContext) => Promise<SharedPollSignatureResult>);
    private _sharedPollSignatureRefreshTimeout?;
    private _sharedPollSignatureRefreshAttempts;
    private _sharedPollTrackRetryTimeout?;
    private _sharedPollTrackRetryAttempts;
    private _sharedPollReplayRetryTimeout?;
    private _sharedPollReplayRetryAttempts;
    protected _sharedPollSignatures: Array<{
        keys: string[];
        signature: string;
    }>;
    private _sharedPollSignatureRefreshTargetMs;
    protected _sharedPollSignatureRefreshInFlight: boolean;
    /** Subscription constructor should not be used directly, create subscriptions using Client method. */
    constructor(centrifuge: Centrifuge, channel: string, options?: Partial<InternalSubscriptionOptions>);
    /** ready returns a Promise which resolves upon subscription goes to Subscribed
     * state and rejects in case of subscription goes to Unsubscribed state.
     * Optional timeout can be passed.*/
    ready(timeout?: number): Promise<void>;
    /** subscribe to a channel.*/
    subscribe(): void;
    /** unsubscribe from a channel, keeping position state.*/
    unsubscribe(): void;
    protected _debouncedPublish(key: string, data: any, isMap: boolean): Promise<PublishResult>;
    protected _cancelDebounce(key: string): void;
    private _cancelAllDebounce;
    /** get online presence for a channel.*/
    presence(): Promise<PresenceResult>;
    /** presence stats for a channel (num clients and unique users).*/
    presenceStats(): Promise<PresenceStatsResult>;
    /**
     * Sets server-side tags filter for the subscription.
     * This only applies on the next subscription attempt, not the current one.
     * Cannot be used together with delta option.
     *
     * @param tagsFilter - Filter configuration object or null to remove filter
     * @throws {Error} If both delta and tagsFilter are configured
     *
     * @example
     * ```typescript
     * // Simple equality filter
     * sub.setTagsFilter({
     *   key: 'ticker',
     *   cmp: 'eq',
     *   val: 'BTC'
     * });
     * ```
     *
     * @example
     * ```typescript
     * // Complex filter with logical operators
     * sub.setTagsFilter({
     *   op: 'and',
     *   nodes: [
     *     { key: 'ticker', cmp: 'eq', val: 'BTC' },
     *     { key: 'price', cmp: 'gt', val: '50000' }
     *   ]
     * });
     * ```
     *
     * @example
     * ```typescript
     * // Filter with IN operator
     * sub.setTagsFilter({
     *   key: 'ticker',
     *   cmp: 'in',
     *   vals: ['BTC', 'ETH', 'SOL']
     * });
     * ```
     */
    setTagsFilter(tagsFilter: FilterNode | null): void;
    /** setData allows setting subscription data. This only applied on the next subscription attempt,
     * Note that if getData callback is configured, it will override this value during resubscriptions. */
    setData(data: any): void;
    /** deltaStats returns delta compression statistics for this subscription.
     * Only meaningful when delta compression is enabled (delta: 'fossil'). */
    deltaStats(): DeltaStats;
    protected _methodCall(): Promise<void>;
    private _nextPromiseId;
    private _needRecover;
    private _isUnsubscribed;
    private _isSubscribing;
    protected _isSubscribed(): boolean;
    private _setState;
    private _usesToken;
    private _clearSubscribingState;
    private _clearSubscribedState;
    /** Called on "state invalidated" — unsubscribe code 2502 for this channel,
     *  or connection disconnect code 3014. Clears the token (next subscribe
     *  fetches a fresh one) and the fossil delta base (every subscription type
     *  uses _prevValueMap; a stale base would corrupt decoding of the first
     *  publication after re-subscribe).
     *
     *  Map subscriptions restart from scratch: their recovery position and
     *  materialized-state buffers are dropped so the next subscribe does a full
     *  STATE re-sync.
     *
     *  Stream/shared-poll subscriptions instead reset the recovery position to a
     *  sentinel epoch ("_") the server can never match (offset 0), leaving
     *  _recover untouched: a recoverable subscription then resubscribes with
     *  was_recovering=true, recovered=false (so the app reloads via its existing
     *  recovery-failure path rather than treating it as a brand-new first
     *  subscribe), while a non-recoverable one simply resubscribes. The real
     *  epoch/offset are adopted from the subscribe reply. */
    _invalidateState(): void;
    private _setSubscribed;
    private _setSubscribing;
    private _subscribe;
    private _isTransportOpen;
    private _canSubscribeWithoutGettingToken;
    private _subscribeWithoutToken;
    /** Load stream position from app via getState callback, then proceed to subscribe
     * with recovery from that position. Called only when _offset is null:
     * - Initial subscribe (no saved position)
     * - After position reset due to failed recovery (see _setSubscribed)
     *
     * NOT called on normal reconnects where the SDK has a saved position — in that
     * case recovery is attempted first, and getState is only invoked if recovery fails.
     *
     * The app's getState callback should:
     * 1. Read cf_stream_top_position (or equivalent) FIRST to capture the stream position
     * 2. Then read its own data from the database/API
     * 3. Render/update the UI
     * 4. Return the captured stream position
     *
     * This order is critical: reading position first ensures it's a lower bound.
     * Recovered publications may overlap with data the app already loaded — this
     * requires idempotent updates or offset-based dedup. */
    private _loadStreamState;
    private _getDataAndSubscribe;
    private _handleGetDataError;
    private _handleTokenResponse;
    private _handleTokenError;
    private _sendSubscribe;
    private _buildSubscribeCommand;
    private _debug;
    private _handleSubscribeError;
    private _handleSubscribeResponse;
    private _setUnsubscribed;
    private _handlePublication;
    /** Seed per-key delta tracking from state/stream entries.
     * Handles JSON-escaped data (server-side delta escaping) and protobuf data.
     * Decodes escaped data back to original format for user consumption. */
    private _seedDeltaTracking;
    protected _handleJoin(join: any): void;
    protected _handleLeave(leave: any): void;
    private _resolvePromises;
    private _rejectPromises;
    private _scheduleResubscribe;
    private _subscribeError;
    private _getResubscribeDelay;
    private _setOptions;
    private _getOffset;
    private _getEpoch;
    private _clearRefreshTimeout;
    private _clearResubscribeTimeout;
    private _getSubscriptionToken;
    private _refresh;
    private _refreshResponse;
    private _refreshError;
    private _getRefreshRetryDelay;
    private _failUnauthorized;
    protected _sendTrackRequest(batches: Array<{
        items: {
            key: string;
            version: number;
        }[];
        signature: string;
    }>, untrackKeys?: string[]): Promise<void>;
    protected _sendUntrackRequest(keys: string[]): Promise<void>;
    private _handleTrackResponse;
    private _maybeScheduleSharedPollSignatureRefresh;
    private _clearSharedPollSignatureRefresh;
    private _clearSharedPollTrackRetry;
    private _clearSharedPollReplayRetry;
    protected _handleTrackError(err: any): void;
    private _sharedPollRefreshSignature;
    private _sharedPollReplayTrack;
    /** Entry point for map subscriptions */
    private _mapSubscribe;
    /** Fetch a page of snapshot data */
    private _fetchSnapshot;
    /** Process snapshot response */
    private _handleMapStateResponse;
    /** Transition from STATE to STREAM phase after snapshot pagination completes */
    private _transitionFromSnapshot;
    /** Fetch stream data (offset-based catch-up) */
    private _fetchStream;
    /** Process stream response */
    private _handleMapStreamResponse;
    /** Process live response - complete the map subscription */
    private _handleMapLiveResponse;
    /** Handle errors during map subscription process */
    private _handleMapSubscribeError;
    /** Build map subscribe command for a specific phase */
    private _buildMapSubscribeCommand;
    /** Convert raw publication to MapUpdateContext */
    private _getMapUpdateContext;
    /** Convert raw publication to SharedPollUpdateContext */
    private _getSharedPollUpdateContext;
}
/** Stream subscription with publish/history methods. */
export declare class Subscription extends BaseSubscription {
    /** Publish data to the channel. */
    publish(data: any): Promise<PublishResult>;
    /** history for a channel. By default it does not return publications (only current
     *  StreamPosition data) – provide an explicit limit > 0 to load publications.*/
    history(opts: HistoryOptions): Promise<HistoryResult>;
}
/** Map subscription with publish/remove methods. */
export declare class MapSubscription extends BaseSubscription {
    /** Publish data to a key. */
    publish(key: string, data: any): Promise<PublishResult>;
    /** Remove a key. */
    remove(key: string): Promise<PublishResult>;
}
/** Shared poll subscription with track/untrack/trackedKeys. */
export declare class SharedPollSubscription extends BaseSubscription {
    /** Track items in a shared poll subscription.
     *
     * Overloads:
     * - `track(keys: string[])` — pass key names only (version defaults to 0).
     *   Requires `getSignature` callback in subscription options. The SDK
     *   automatically obtains a signature before sending the track request.
     * - `track(items: SharedPollTrackItem[], signature: string)` — pass items
     *   with explicit versions and a pre-computed HMAC signature.
     *
     * Items are stored in local state immediately. If subscribed, the track request
     * is sent right away. If not yet subscribed, items will be sent via replay
     * (with a fresh signature from getSignature) after subscribe completes.
     *
     * **Fire-and-forget** (similar to subscribe/unsubscribe): returns void and never
     * throws for in-flight failures. Subscribe to the `error` event to observe
     * failures: `type: 'track'` covers both the server-side track request and
     * the `getSignature` callback when using `track(keys)`. Server-revoked keys
     * arrive as synthetic `update` events with `removed: true`. */
    track(keysOrItems: string[] | SharedPollTrackItem[], signature?: string): void;
    /** Stop tracking specific keys in a shared poll subscription.
     * Keys are removed from local state immediately. If subscribed, the untrack
     * request is sent right away. If not yet subscribed, the keys simply won't
     * be included in the replay after subscribe completes.
     *
     * **Fire-and-forget** (similar to subscribe/unsubscribe): returns void and never
     * throws for in-flight failures. Subscribe to the `error` event with
     * `type: 'untrack'` to observe failures of the untrack request. */
    untrack(keys: string[]): void;
    /** Returns the set of currently tracked keys in a shared poll subscription. */
    trackedKeys(): Set<string>;
}
export {};
