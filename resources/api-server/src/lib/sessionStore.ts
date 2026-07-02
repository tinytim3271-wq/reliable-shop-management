import session, { type SessionData, type Store } from "express-session";
import connectPgSimple from "connect-pg-simple";
import { eq } from "drizzle-orm";
import { db, getPgPool, runtimeConfig, sessionTable } from "@workspace/db";

// Default cookie TTL, mirrored from the session() config, used when a session
// has no explicit cookie.expires to derive the row's expiry.
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function expiryFrom(sess: SessionData): Date {
  const cookie = sess.cookie;
  if (cookie?.expires) return new Date(cookie.expires);
  const maxAge = cookie?.maxAge ?? DEFAULT_TTL_MS;
  return new Date(Date.now() + maxAge);
}

/**
 * Desktop (PGlite) session store. connect-pg-simple requires a node-pg Pool,
 * which the embedded driver does not provide, so we back express-session with
 * Drizzle over the same `session` table (sid / sess / expire) that
 * connect-pg-simple uses in hosted mode. This persists sessions across hub
 * restarts (unlike MemoryStore) and is shared by every LAN client.
 */
class DrizzleSessionStore extends session.Store {
  get(
    sid: string,
    cb: (err: unknown, session?: SessionData | null) => void,
  ): void {
    void (async () => {
      try {
        const rows = await db
          .select()
          .from(sessionTable)
          .where(eq(sessionTable.sid, sid))
          .limit(1);
        const row = rows[0];
        if (!row) return cb(null, null);
        if (row.expire.getTime() <= Date.now()) {
          await db.delete(sessionTable).where(eq(sessionTable.sid, sid));
          return cb(null, null);
        }
        cb(null, row.sess as SessionData);
      } catch (err) {
        cb(err);
      }
    })();
  }

  set(sid: string, sess: SessionData, cb?: (err?: unknown) => void): void {
    void (async () => {
      try {
        const expire = expiryFrom(sess);
        await db
          .insert(sessionTable)
          .values({ sid, sess, expire })
          .onConflictDoUpdate({
            target: sessionTable.sid,
            set: { sess, expire },
          });
        cb?.();
      } catch (err) {
        cb?.(err);
      }
    })();
  }

  destroy(sid: string, cb?: (err?: unknown) => void): void {
    void (async () => {
      try {
        await db.delete(sessionTable).where(eq(sessionTable.sid, sid));
        cb?.();
      } catch (err) {
        cb?.(err);
      }
    })();
  }

  touch(sid: string, sess: SessionData, cb?: (err?: unknown) => void): void {
    void (async () => {
      try {
        await db
          .update(sessionTable)
          .set({ expire: expiryFrom(sess) })
          .where(eq(sessionTable.sid, sid));
        cb?.();
      } catch (err) {
        cb?.(err);
      }
    })();
  }
}

/**
 * Build the express-session store for the active runtime. Hosted keeps the
 * proven connect-pg-simple store on the node-pg Pool; desktop uses the
 * Drizzle/PGlite-backed store above.
 */
export function createSessionStore(): Store {
  if (runtimeConfig.dbDriver === "pglite") {
    return new DrizzleSessionStore();
  }
  const PgSession = connectPgSimple(session);
  return new PgSession({ pool: getPgPool(), tableName: "session" });
}
