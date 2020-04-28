type FollowEvent = {
    from_id: string,
    from_name: string,
    to_id: string,
    to_name: string,
    followed_at: Date
};

type StreamChangedEvent = {
    id: string,
    user_id: string,
    user_name: string,
    game_id: string,
    community_ids: string[],
    type: string,
    title: string,
    viewer_count: number,
    started_at: Date,
    language: string,
    thumbnail_url: string
};

type UserChangedEvent = {
    id: string,
    login: string,
    display_name: string,
    type: string,
    broadcaster_type: string,
    description: string,
    profile_image_url: string,
    offline_image_url: string,
    view_count: number,
};

type CostData = {
    amount: number,
    type: string, // Always "Bits",
}

type ProductData = {
    domain: string,
    broadcast: boolean,
    expiration: string, // always empty (only unexpired products can be purchased)
    sku: string,
    cost: CostData,
    displayName: string,
    inDevelopment: boolean
}

type ExtensionTransactionCreatedEvent = {
    id: string,
    timestamp: Date,
    broadcaster_id: string,
    broadcaster_name: string,
    user_id: string,
    user_name: string,
    product_type: string, // Always BITS_IN_EXTENSION
    product_data: ProductData,
};

enum ModeratorEventType {
    MODERATOR_ADD = "moderation.moderator.add",
    MODERATOR_REMOVE = "moderation.moderator.remove",
    BAN_USER = "moderation.user.ban",
    UNBAN_USER = "moderation.user.unban"
}

type ModeratorEventData = {
    broadcaster_id: string,
    broadcaster_name: string,
    user_id: string,
    user_name: string
}

type ModeratorChangeEvent = {
    id: string, // Docs says that this is the user id of the moderator. There is no way I buy that for a second. This is the unique event ID.
    event_type: ModeratorEventType,
    event_timestamp: Date,
    version: string,
    event_data: ModeratorEventData// TODO: Check if this is only mod add and remove - not ban & unban
};

type ChannelBanChangeEvent = {
    id: string, // Docs says that this is the user id of the moderator. There is no way I buy that for a second. This is the unique event ID.
    event_type: ModeratorEventType,
    event_timestamp: Date,
    version: string,
    event_data: ModeratorEventData // TODO: Check if this is only ban & unban - not mod add and remove
};

enum SubscriptionEventType {
    SUBSCRIBE = "subscriptions.subscribe",
    NOTIFICATION = "subscriptions.notification",
    UNSUBSCRIBE = "subscriptions.unsubscribe"
}

type SubscriptionEventData = {
    broadcaster_id: string,
    broadcaster_name: string,
    is_gift: boolean,
    plan_name: string,
    tier: string,
    user_id: string,
    user_name: string,
    message?: string
}

type SubscriptionEvent = {
    id: string,
    event_type: SubscriptionEventType,
    event_timestamp: Date,
    version: string,
    event_data: SubscriptionEventData
};

type WebhookPayload = {
    data: FollowEvent | StreamChangedEvent | UserChangedEvent | ExtensionTransactionCreatedEvent | ModeratorChangeEvent | ChannelBanChangeEvent | SubscriptionEvent;
};

//TODO write function to coerce "any" type to the above types.

export {
    WebhookPayload
}