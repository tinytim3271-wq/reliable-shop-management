import Stripe from 'stripe';
import pg, { PoolConfig, QueryResult } from 'pg';
import { ConnectionOptions } from 'node:tls';

type PostgresConfig = {
    schema: string;
    poolConfig: PoolConfig;
};
declare class PostgresClient {
    private config;
    pool: pg.Pool;
    constructor(config: PostgresConfig);
    delete(table: string, id: string): Promise<boolean>;
    query(text: string, params?: any[]): Promise<QueryResult>;
    upsertMany<T extends {
        [Key: string]: any;
    }>(entries: T[], table: string): Promise<T[]>;
    upsertManyWithTimestampProtection<T extends {
        [Key: string]: any;
    }>(entries: T[], table: string, accountId: string, syncTimestamp?: string): Promise<T[]>;
    private cleanseArrayField;
    findMissingEntries(table: string, ids: string[]): Promise<string[]>;
    getSyncCursor(resource: string, accountId: string): Promise<number | null>;
    updateSyncCursor(resource: string, accountId: string, cursor: number): Promise<void>;
    markSyncRunning(resource: string, accountId: string): Promise<void>;
    markSyncComplete(resource: string, accountId: string): Promise<void>;
    markSyncError(resource: string, accountId: string, errorMessage: string): Promise<void>;
    upsertAccount(accountData: {
        id: string;
        raw_data: any;
    }, apiKeyHash: string): Promise<void>;
    getAllAccounts(): Promise<any[]>;
    /**
     * Looks up an account ID by API key hash
     * Uses the GIN index on api_key_hashes for fast lookups
     * @param apiKeyHash - SHA-256 hash of the Stripe API key
     * @returns Account ID if found, null otherwise
     */
    getAccountIdByApiKeyHash(apiKeyHash: string): Promise<string | null>;
    getAccountRecordCounts(accountId: string): Promise<{
        [tableName: string]: number;
    }>;
    deleteAccountWithCascade(accountId: string, useTransaction: boolean): Promise<{
        [tableName: string]: number;
    }>;
    /**
     * Hash a string to a 32-bit integer for use with PostgreSQL advisory locks.
     * Uses a simple hash algorithm that produces consistent results.
     */
    private hashToInt32;
    /**
     * Acquire a PostgreSQL advisory lock for the given key.
     * This lock is automatically released when the connection is closed or explicitly released.
     * Advisory locks are session-level and will block until the lock is available.
     *
     * @param key - A string key to lock on (will be hashed to an integer)
     */
    acquireAdvisoryLock(key: string): Promise<void>;
    /**
     * Release a PostgreSQL advisory lock for the given key.
     *
     * @param key - The same string key used to acquire the lock
     */
    releaseAdvisoryLock(key: string): Promise<void>;
    /**
     * Execute a function while holding an advisory lock.
     * The lock is automatically released after the function completes (success or error).
     *
     * IMPORTANT: This acquires a dedicated connection from the pool and holds it for the
     * duration of the function execution. PostgreSQL advisory locks are session-level,
     * so we must use the same connection for lock acquisition, operations, and release.
     *
     * @param key - A string key to lock on (will be hashed to an integer)
     * @param fn - The function to execute while holding the lock
     * @returns The result of the function
     */
    withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Simple logger interface compatible with both pino and console
 */
interface Logger {
    info(message?: unknown, ...optionalParams: unknown[]): void;
    warn(message?: unknown, ...optionalParams: unknown[]): void;
    error(message?: unknown, ...optionalParams: unknown[]): void;
}
type RevalidateEntity = 'charge' | 'credit_note' | 'customer' | 'dispute' | 'invoice' | 'payment_intent' | 'payment_method' | 'plan' | 'price' | 'product' | 'refund' | 'review' | 'radar.early_fraud_warning' | 'setup_intent' | 'subscription' | 'subscription_schedule' | 'tax_id' | 'entitlements';
type StripeSyncConfig = {
    /** @deprecated Use `poolConfig` with a connection string instead. */
    databaseUrl?: string;
    /** Stripe secret key used to authenticate requests to the Stripe API. Defaults to empty string */
    stripeSecretKey: string;
    /** Stripe account ID. If not provided, will be retrieved from Stripe API. Used as fallback option. */
    stripeAccountId?: string;
    /** Stripe webhook signing secret for validating webhook signatures. Required if not using managed webhooks. */
    stripeWebhookSecret?: string;
    /** Stripe API version for the webhooks, defaults to 2020-08-27 */
    stripeApiVersion?: string;
    /**
     * Stripe limits related lists like invoice items in an invoice to 10 by default.
     * By enabling this, sync-engine automatically fetches the remaining elements before saving
     * */
    autoExpandLists?: boolean;
    /**
     * If true, the sync engine will backfill related entities, i.e. when a invoice webhook comes in, it ensures that the customer is present and synced.
     * This ensures foreign key integrity, but comes at the cost of additional queries to the database (and added latency for Stripe calls if the entity is actually missing).
     */
    backfillRelatedEntities?: boolean;
    /**
     * If true, the webhook data is not used and instead the webhook is just a trigger to fetch the entity from Stripe again. This ensures that a race condition with failed webhooks can never accidentally overwrite the data with an older state.
     *
     * Default: false
     */
    revalidateObjectsViaStripeApi?: Array<RevalidateEntity>;
    /** @deprecated Use `poolConfig` instead. */
    maxPostgresConnections?: number;
    poolConfig: PoolConfig;
    logger?: Logger;
    /**
     * Maximum number of retry attempts for 429 rate limit errors.
     * Default: 5
     */
    maxRetries?: number;
    /**
     * Initial delay in milliseconds before first retry attempt.
     * Delay increases exponentially: 1s, 2s, 4s, 8s, 16s, etc.
     * Default: 1000 (1 second)
     */
    initialRetryDelayMs?: number;
    /**
     * Maximum delay in milliseconds between retry attempts.
     * Default: 60000 (60 seconds)
     */
    maxRetryDelayMs?: number;
    /**
     * Random jitter in milliseconds added to retry delays to prevent thundering herd.
     * Default: 500
     */
    retryJitterMs?: number;
};
type SyncObject = 'all' | 'customer' | 'customer_with_entitlements' | 'invoice' | 'price' | 'product' | 'subscription' | 'subscription_schedules' | 'setup_intent' | 'payment_method' | 'dispute' | 'charge' | 'payment_intent' | 'plan' | 'tax_id' | 'credit_note' | 'early_fraud_warning' | 'refund' | 'checkout_sessions';
interface Sync {
    synced: number;
}
interface SyncBackfill {
    products?: Sync;
    prices?: Sync;
    plans?: Sync;
    customers?: Sync;
    subscriptions?: Sync;
    subscriptionSchedules?: Sync;
    invoices?: Sync;
    setupIntents?: Sync;
    paymentIntents?: Sync;
    paymentMethods?: Sync;
    disputes?: Sync;
    charges?: Sync;
    taxIds?: Sync;
    creditNotes?: Sync;
    earlyFraudWarnings?: Sync;
    refunds?: Sync;
    checkoutSessions?: Sync;
}
interface SyncBackfillParams {
    created?: {
        /**
         * Minimum value to filter by (exclusive)
         */
        gt?: number;
        /**
         * Minimum value to filter by (inclusive)
         */
        gte?: number;
        /**
         * Maximum value to filter by (exclusive)
         */
        lt?: number;
        /**
         * Maximum value to filter by (inclusive)
         */
        lte?: number;
    };
    object?: SyncObject;
    backfillRelatedEntities?: boolean;
}
interface SyncEntitlementsParams {
    object: 'entitlements';
    customerId: string;
    pagination?: Pick<Stripe.PaginationParams, 'starting_after' | 'ending_before'>;
}
interface SyncFeaturesParams {
    object: 'features';
    pagination?: Pick<Stripe.PaginationParams, 'starting_after' | 'ending_before'>;
}

declare class StripeSync {
    private config;
    stripe: Stripe;
    postgresClient: PostgresClient;
    private cachedAccount;
    constructor(config: StripeSyncConfig);
    /**
     * Get the Stripe account ID. Uses database lookup by API key hash for fast lookups,
     * with fallback to Stripe API if not found (first-time setup or new API key).
     */
    getAccountId(objectAccountId?: string): Promise<string>;
    /**
     * Upsert Stripe account information to the database
     * @param account - Stripe account object
     * @param apiKeyHash - SHA-256 hash of API key to store for fast lookups
     */
    private upsertAccount;
    /**
     * Get the current account being synced
     */
    getCurrentAccount(): Promise<Stripe.Account | null>;
    /**
     * Get all accounts that have been synced to the database
     */
    getAllSyncedAccounts(): Promise<Stripe.Account[]>;
    /**
     * DANGEROUS: Delete an account and all associated data from the database
     * This operation cannot be undone!
     *
     * @param accountId - The Stripe account ID to delete
     * @param options - Options for deletion behavior
     * @param options.dryRun - If true, only count records without deleting (default: false)
     * @param options.useTransaction - If true, use transaction for atomic deletion (default: true)
     * @returns Deletion summary with counts and warnings
     */
    dangerouslyDeleteSyncedAccountData(accountId: string, options?: {
        dryRun?: boolean;
        useTransaction?: boolean;
    }): Promise<{
        deletedAccountId: string;
        deletedRecordCounts: {
            [tableName: string]: number;
        };
        warnings: string[];
    }>;
    processWebhook(payload: Buffer | string, signature: string | undefined): Promise<void>;
    private readonly eventHandlers;
    processEvent(event: Stripe.Event): Promise<void>;
    /**
     * Returns an array of all webhook event types that this sync engine can handle.
     * Useful for configuring webhook endpoints with specific event subscriptions.
     */
    getSupportedEventTypes(): Stripe.WebhookEndpointCreateParams.EnabledEvent[];
    private handleChargeEvent;
    private handleCustomerDeletedEvent;
    private handleCustomerEvent;
    private handleCheckoutSessionEvent;
    private handleSubscriptionEvent;
    private handleTaxIdEvent;
    private handleTaxIdDeletedEvent;
    private handleInvoiceEvent;
    private handleProductEvent;
    private handleProductDeletedEvent;
    private handlePriceEvent;
    private handlePriceDeletedEvent;
    private handlePlanEvent;
    private handlePlanDeletedEvent;
    private handleSetupIntentEvent;
    private handleSubscriptionScheduleEvent;
    private handlePaymentMethodEvent;
    private handleDisputeEvent;
    private handlePaymentIntentEvent;
    private handleCreditNoteEvent;
    private handleEarlyFraudWarningEvent;
    private handleRefundEvent;
    private handleReviewEvent;
    private handleEntitlementSummaryEvent;
    private getSyncTimestamp;
    private shouldRefetchEntity;
    private fetchOrUseWebhookData;
    syncSingleEntity(stripeId: string): Promise<Stripe.Charge[] | (Stripe.Customer | Stripe.DeletedCustomer)[] | Stripe.Checkout.Session[] | Stripe.Subscription[] | Stripe.TaxId[] | Stripe.Invoice[] | Stripe.Product[] | Stripe.Price[] | Stripe.SetupIntent[] | Stripe.PaymentMethod[] | Stripe.Dispute[] | Stripe.PaymentIntent[] | Stripe.CreditNote[] | Stripe.Radar.EarlyFraudWarning[] | Stripe.Refund[] | Stripe.Review[] | Stripe.Entitlements.Feature[] | undefined>;
    syncBackfill(params?: SyncBackfillParams): Promise<SyncBackfill>;
    syncProducts(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncPrices(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncPlans(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncCustomers(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncSubscriptions(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncSubscriptionSchedules(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncInvoices(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncCharges(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncSetupIntents(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncPaymentIntents(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncTaxIds(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncPaymentMethods(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncDisputes(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncEarlyFraudWarnings(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncRefunds(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncCreditNotes(syncParams?: SyncBackfillParams): Promise<Sync>;
    syncFeatures(syncParams?: SyncFeaturesParams): Promise<Sync>;
    syncEntitlements(customerId: string, syncParams?: SyncEntitlementsParams): Promise<Sync>;
    syncCheckoutSessions(syncParams?: SyncBackfillParams): Promise<Sync>;
    private fetchAndUpsert;
    private upsertCharges;
    private backfillCharges;
    private backfillPaymentIntents;
    private upsertCreditNotes;
    upsertCheckoutSessions(checkoutSessions: Stripe.Checkout.Session[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.Checkout.Session[]>;
    upsertEarlyFraudWarning(earlyFraudWarnings: Stripe.Radar.EarlyFraudWarning[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.Radar.EarlyFraudWarning[]>;
    upsertRefunds(refunds: Stripe.Refund[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.Refund[]>;
    upsertReviews(reviews: Stripe.Review[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.Review[]>;
    upsertCustomers(customers: (Stripe.Customer | Stripe.DeletedCustomer)[], accountId: string, syncTimestamp?: string): Promise<(Stripe.Customer | Stripe.DeletedCustomer)[]>;
    backfillCustomers(customerIds: string[], accountId: string): Promise<void>;
    upsertDisputes(disputes: Stripe.Dispute[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.Dispute[]>;
    upsertInvoices(invoices: Stripe.Invoice[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.Invoice[]>;
    backfillInvoices: (invoiceIds: string[], accountId: string) => Promise<void>;
    backfillPrices: (priceIds: string[], accountId: string) => Promise<void>;
    upsertPlans(plans: Stripe.Plan[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.Plan[]>;
    deletePlan(id: string): Promise<boolean>;
    upsertPrices(prices: Stripe.Price[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.Price[]>;
    deletePrice(id: string): Promise<boolean>;
    upsertProducts(products: Stripe.Product[], accountId: string, syncTimestamp?: string): Promise<Stripe.Product[]>;
    deleteProduct(id: string): Promise<boolean>;
    backfillProducts(productIds: string[], accountId: string): Promise<void>;
    upsertPaymentIntents(paymentIntents: Stripe.PaymentIntent[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.PaymentIntent[]>;
    upsertPaymentMethods(paymentMethods: Stripe.PaymentMethod[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.PaymentMethod[]>;
    upsertSetupIntents(setupIntents: Stripe.SetupIntent[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.SetupIntent[]>;
    upsertTaxIds(taxIds: Stripe.TaxId[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.TaxId[]>;
    deleteTaxId(id: string): Promise<boolean>;
    upsertSubscriptionItems(subscriptionItems: Stripe.SubscriptionItem[], accountId: string, syncTimestamp?: string): Promise<void>;
    fillCheckoutSessionsLineItems(checkoutSessionIds: string[], accountId: string, syncTimestamp?: string): Promise<void>;
    upsertCheckoutSessionLineItems(lineItems: Stripe.LineItem[], checkoutSessionId: string, accountId: string, syncTimestamp?: string): Promise<void>;
    markDeletedSubscriptionItems(subscriptionId: string, currentSubItemIds: string[]): Promise<{
        rowCount: number;
    }>;
    upsertSubscriptionSchedules(subscriptionSchedules: Stripe.SubscriptionSchedule[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.SubscriptionSchedule[]>;
    upsertSubscriptions(subscriptions: Stripe.Subscription[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<Stripe.Subscription[]>;
    deleteRemovedActiveEntitlements(customerId: string, currentActiveEntitlementIds: string[]): Promise<{
        rowCount: number;
    }>;
    upsertFeatures(features: Stripe.Entitlements.Feature[], accountId: string, syncTimestamp?: string): Promise<Stripe.Entitlements.Feature[]>;
    backfillFeatures(featureIds: string[], accountId: string): Promise<void>;
    upsertActiveEntitlements(customerId: string, activeEntitlements: Stripe.Entitlements.ActiveEntitlement[], accountId: string, backfillRelatedEntities?: boolean, syncTimestamp?: string): Promise<{
        id: string;
        object: "entitlements.active_entitlement";
        feature: string;
        customer: string;
        livemode: boolean;
        lookup_key: string;
    }[]>;
    findOrCreateManagedWebhook(url: string, params?: Omit<Stripe.WebhookEndpointCreateParams, 'url'>): Promise<Stripe.WebhookEndpoint>;
    getManagedWebhook(id: string): Promise<Stripe.WebhookEndpoint | null>;
    /**
     * Get a managed webhook by URL and account ID.
     * Used for race condition recovery: when createManagedWebhook hits a unique constraint
     * violation (another instance created the webhook), we need to fetch the existing webhook
     * by URL since we only know the URL, not the ID of the webhook that won the race.
     */
    getManagedWebhookByUrl(url: string): Promise<Stripe.WebhookEndpoint | null>;
    listManagedWebhooks(): Promise<Array<Stripe.WebhookEndpoint>>;
    updateManagedWebhook(id: string, params: Stripe.WebhookEndpointUpdateParams): Promise<Stripe.WebhookEndpoint>;
    deleteManagedWebhook(id: string): Promise<boolean>;
    upsertManagedWebhooks(webhooks: Array<Stripe.WebhookEndpoint>, accountId: string, syncTimestamp?: string): Promise<Array<Stripe.WebhookEndpoint>>;
    backfillSubscriptions(subscriptionIds: string[], accountId: string): Promise<void>;
    backfillSubscriptionSchedules: (subscriptionIds: string[], accountId: string) => Promise<void>;
    /**
     * Stripe only sends the first 10 entries by default, the option will actively fetch all entries.
     */
    private expandEntity;
    private fetchMissingEntities;
}

type MigrationConfig = {
    databaseUrl: string;
    ssl?: ConnectionOptions;
    logger?: Logger;
};
declare function runMigrations(config: MigrationConfig): Promise<void>;

/**
 * Hashes a Stripe API key using SHA-256
 * Used to store API key hashes in the database for fast account lookups
 * without storing the actual API key or making Stripe API calls
 *
 * @param apiKey - The Stripe API key (e.g., sk_test_... or sk_live_...)
 * @returns SHA-256 hash of the API key as a hex string
 */
declare function hashApiKey(apiKey: string): string;

export { type Logger, PostgresClient, type RevalidateEntity, StripeSync, type StripeSyncConfig, type Sync, type SyncBackfill, type SyncBackfillParams, type SyncEntitlementsParams, type SyncFeaturesParams, type SyncObject, hashApiKey, runMigrations };
