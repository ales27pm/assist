/** Options for a subscribe reply. Extend with more fields as scenarios need them. */
export interface SubscribeReplyOptions {
    id?: number;
    recoverable?: boolean;
    positioned?: boolean;
    epoch?: string;
    offset?: number;
    recovered?: boolean;
    wasRecovering?: boolean;
    expires?: boolean;
    ttl?: number;
    data?: any;
    publications?: any[];
}
/** Push target: a numeric channel id (channel compaction) or a channel name. */
export type PushTarget = number | string;
export type CommandHandler = (cmd: any, server: FakeCentrifugoServer) => any | null | undefined;
export type SubscribeHandler = (channel: string, req: any) => SubscribeReplyOptions;
export declare class FakeCentrifugoServer {
    private wss;
    private current;
    /** All commands received from the client, in order. */
    readonly received: any[];
    /** connect reply fields. Override to set expires/ttl/data/etc. */
    connectResult: any;
    /** Full override for any command — return a reply object to send, or
     *  null/undefined to fall through to default handling. */
    onCommand: CommandHandler | null;
    /** Customize the subscribe result per channel (default: empty result). */
    onSubscribe: SubscribeHandler | null;
    private constructor();
    static start(): Promise<FakeCentrifugoServer>;
    get url(): string;
    /** The most recent subscribe request the client sent (or undefined). */
    get lastSubscribe(): any;
    /** Stop the server. */
    close(): Promise<void>;
    /** Close the active connection from the server side, triggering the client's
     *  automatic reconnect. */
    closeConnection(): void;
    private dispatch;
    /** Send a raw reply object. */
    send(reply: any): void;
    /** Send a raw push (wrapped in a reply). */
    sendPush(push: any): void;
    private targetFields;
    publish(target: PushTarget, data: any, extra?: any): void;
    join(target: PushTarget, info: any): void;
    leave(target: PushTarget, info: any): void;
    unsubscribe(channel: string, code: number, reason: string): void;
    disconnect(code: number, reason: string): void;
    message(data: any): void;
}
