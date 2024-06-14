import {
  Accept,
  Activity,
  Announce,
  Article,
  Create,
  Delete,
  Endpoints,
  Federation,
  Follow,
  Image,
  InProcessMessageQueue,
  Like,
  MemoryKvStore,
  Note,
  PropertyValue,
  Reject,
  Undo,
  Update,
  getActorClassByTypeName,
  importJwk,
  isActor,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { parse } from "@std/semver";
import { and, count, eq, ilike, inArray, like, sql } from "drizzle-orm";
import metadata from "../../package.json" with { type: "json" };
import db from "../db";
import {
  type NewLike,
  accountOwners,
  accounts,
  follows,
  likes,
  posts,
} from "../schema";
import { persistAccount } from "./account";
import { toTemporalInstant } from "./date";
import { persistPost, persistSharingPost, toObject } from "./post";

export const federation = new Federation({
  kv: new MemoryKvStore(),
  queue: new InProcessMessageQueue(),
});

federation
  .setActorDispatcher("/@{handle}", async (ctx, handle, key) => {
    const owner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.handle, handle),
      with: { account: true },
    });
    if (owner == null) return null;
    const account = owner.account;
    const cls = getActorClassByTypeName(account.type);
    return new cls({
      id: new URL(account.iri),
      name: account.name,
      preferredUsername: handle,
      summary: account.bioHtml,
      url: account.url ? new URL(account.url) : null,
      manuallyApprovesFollowers: account.protected,
      icon: account.avatarUrl
        ? new Image({ url: new URL(account.avatarUrl) })
        : null,
      image: account.coverUrl
        ? new Image({ url: new URL(account.coverUrl) })
        : null,
      published: account.published
        ? toTemporalInstant(account.published)
        : null,
      publicKey: key,
      followers: ctx.getFollowersUri(handle),
      following: ctx.getFollowingUri(handle),
      outbox: ctx.getOutboxUri(handle),
      inbox: ctx.getInboxUri(handle),
      endpoints: new Endpoints({
        sharedInbox: ctx.getInboxUri(),
      }),
      attachments: Object.entries(account.fieldHtmls).map(
        ([name, value]) =>
          new PropertyValue({
            name,
            value,
          }),
      ),
    });
  })
  .setKeyPairDispatcher(async (_ctx, handle) => {
    const owner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.handle, handle),
    });
    if (owner == null) return null;
    return {
      privateKey: await importJwk(owner.privateKeyJwk, "private"),
      publicKey: await importJwk(owner.publicKeyJwk, "public"),
    };
  });

federation
  .setFollowersDispatcher(
    "/@{handle}/followers",
    async (_ctx, handle, cursor, filter) => {
      const owner = await db.query.accountOwners.findFirst({
        where: eq(accountOwners.handle, handle),
      });
      if (owner == null || cursor == null) return null;
      const offset = Number.parseInt(cursor);
      if (!Number.isInteger(offset)) return null;
      const followers = await db.query.accounts.findMany({
        where: and(
          inArray(
            accounts.id,
            db
              .select({ id: follows.followerId })
              .from(follows)
              .where(eq(follows.followingId, owner.id)),
          ),
          filter == null
            ? undefined
            : ilike(accounts.iri, `${filter.origin}/%`),
        ),
        offset,
        orderBy: accounts.id,
        limit: 41,
      });
      return {
        items: followers.slice(0, 40).map((f) => ({
          id: new URL(f.iri),
          inboxId: new URL(f.inboxUrl),
          endpoints: {
            sharedInbox: f.sharedInboxUrl ? new URL(f.sharedInboxUrl) : null,
          },
        })),
        nextCursor: followers.length > 40 ? `${offset + 40}` : null,
      };
    },
  )
  .setFirstCursor(async (_ctx, _handle) => "0")
  .setCounter(async (_ctx, handle) => {
    const result = await db
      .select({ cnt: count() })
      .from(follows)
      .where(
        eq(
          follows.followingId,
          db
            .select({ id: accountOwners.id })
            .from(accountOwners)
            .where(eq(accountOwners.handle, handle)),
        ),
      );
    return result.length > 0 ? result[0].cnt : 0;
  });

federation.setFollowingDispatcher("/@{handle}/following", async (_ctx, _) => {
  return {
    items: [], // TODO: Implement this
  };
});

federation.setOutboxDispatcher("/@{handle}/outbox", async (_ctx, _) => {
  return {
    items: [], // TODO: Implement this
  };
});

const inboxLogger = getLogger(["hollo", "inbox"]);

federation
  .setInboxListeners("/@{handle}/inbox", "/inbox")
  .on(Follow, async (ctx, follow) => {
    if (follow.id == null) return;
    const actor = await follow.getActor();
    if (!isActor(actor) || actor.id == null) {
      inboxLogger.debug("Invalid actor: {actor}", { actor });
      return;
    }
    const object = await follow.getObject();
    if (!isActor(object) || object.id == null) {
      inboxLogger.debug("Invalid object: {object}", { object });
      return;
    }
    const following = await db.query.accounts.findFirst({
      where: eq(accounts.iri, object.id.href),
      with: { owner: true },
    });
    if (following?.owner == null) {
      inboxLogger.debug("Invalid following: {following}", { following });
      return;
    }
    const follower = await persistAccount(db, actor, ctx);
    if (follower == null) return;
    await db
      .insert(follows)
      .values({
        iri: follow.id.href,
        followingId: following.id,
        followerId: follower.id,
        approved: following.protected ? null : new Date(),
      })
      .onConflictDoNothing();
    if (!following.protected) {
      await ctx.sendActivity(
        following.owner,
        actor,
        new Accept({
          actor: object.id,
          object: follow,
        }),
      );
      const result = await db
        .select({ cnt: count() })
        .from(follows)
        .where(eq(follows.followingId, following.id));
      await db
        .update(accounts)
        .set({
          followersCount: result.length < 1 ? 0 : result[0].cnt,
        })
        .where(eq(accounts.id, following.id));
    }
  })
  .on(Accept, async (ctx, accept) => {
    const object = await accept.getObject();
    if (object instanceof Follow) {
      if (object.id == null) return;
      const actor = await accept.getActor();
      if (!isActor(actor) || actor.id == null) {
        inboxLogger.debug("Invalid actor: {actor}", { actor });
        return;
      }
      const account = await persistAccount(db, actor, ctx);
      if (account == null) return;
      await db
        .update(follows)
        .set({ approved: new Date() })
        .where(
          and(
            eq(follows.iri, object.id.href),
            eq(follows.followingId, account.id),
          ),
        );
    }
  })
  .on(Reject, async (ctx, reject) => {
    const object = await reject.getObject();
    if (object instanceof Follow) {
      if (object.id == null) return;
      const actor = await reject.getActor();
      if (!isActor(actor) || actor.id == null) {
        inboxLogger.debug("Invalid actor: {actor}", { actor });
        return;
      }
      const account = await persistAccount(db, actor, ctx);
      if (account == null) return;
      await db
        .delete(follows)
        .where(
          and(
            eq(follows.iri, object.id.href),
            eq(follows.followingId, account.id),
          ),
        );
    }
  })
  .on(Create, async (ctx, create) => {
    const object = await create.getObject();
    if (object instanceof Article || object instanceof Note) {
      await persistPost(db, object, ctx);
    } else {
      inboxLogger.debug("Unsupported object on Create: {object}", { object });
    }
  })
  .on(Like, async (ctx, like) => {
    if (like.objectId == null) return;
    const parsed = ctx.parseUri(like.objectId);
    if (parsed == null) return;
    const { type } = parsed;
    if (
      type === "object" &&
      (parsed.class === Note || parsed.class === Article)
    ) {
      const actor = await like.getActor();
      if (actor == null) return;
      const account = await persistAccount(db, actor, ctx);
      if (account == null) return;
      await db.insert(likes).values({
        // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
        postId: parsed.values["id"],
        accountId: account.id,
      } satisfies NewLike);
    } else {
      inboxLogger.debug("Unsupported object on Like: {objectId}", {
        objectId: like.objectId,
      });
    }
  })
  .on(Announce, async (ctx, announce) => {
    const object = await announce.getObject();
    if (object instanceof Article || object instanceof Note) {
      await db.transaction(async (tx) => {
        await persistSharingPost(tx, announce, object, ctx);
      });
    } else {
      inboxLogger.debug("Unsupported object on Announce: {object}", { object });
    }
  })
  .on(Update, async (ctx, update) => {
    const object = await update.getObject();
    if (isActor(object)) {
      await persistAccount(db, object, ctx);
    } else if (object instanceof Article || object instanceof Note) {
      await persistPost(db, object, ctx);
    } else {
      inboxLogger.debug("Unsupported object on Update: {object}", { object });
    }
  })
  .on(Delete, async (_ctx, del) => {
    const actorId = del.actorId;
    const objectId = del.objectId;
    if (actorId == null || objectId == null) return;
    if (objectId.href === actorId.href) {
      await db.delete(accounts).where(eq(accounts.iri, actorId.href));
    } else {
      await db.delete(posts).where(eq(posts.iri, objectId.href));
    }
  })
  .on(Undo, async (ctx, undo) => {
    const object = await undo.getObject();
    if (
      object instanceof Activity &&
      object.actorId?.href !== undo.actorId?.href
    ) {
      return;
    }
    if (object instanceof Follow) {
      if (object.id == null) return;
      const actor = await undo.getActor();
      if (!isActor(actor) || actor.id == null) {
        inboxLogger.debug("Invalid actor: {actor}", { actor });
        return;
      }
      const account = await persistAccount(db, actor, ctx);
      if (account == null) return;
      const deleted = await db
        .delete(follows)
        .where(
          and(
            eq(follows.iri, object.id.href),
            eq(follows.followerId, account.id),
          ),
        )
        .returning({ followingId: follows.followingId });
      if (deleted.length > 0) {
        const result = await db
          .select({ cnt: count() })
          .from(follows)
          .where(eq(follows.followingId, deleted[0].followingId));
        await db
          .update(accounts)
          .set({
            followersCount: result.length < 1 ? 0 : result[0].cnt,
          })
          .where(eq(accounts.id, deleted[0].followingId));
      }
    } else if (object instanceof Like) {
      const like = object;
      if (like.objectId == null) return;
      const parsed = ctx.parseUri(like.objectId);
      if (parsed == null) return;
      const { type } = parsed;
      if (
        type === "object" &&
        (parsed.class === Note || parsed.class === Article)
      ) {
        const actor = await like.getActor();
        if (actor == null) return;
        const account = await persistAccount(db, actor, ctx);
        if (account == null) return;
        await db.delete(likes).where(
          and(
            // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
            eq(likes.postId, parsed.values["id"]),
            eq(likes.accountId, account.id),
          ),
        );
      } else {
        inboxLogger.debug("Unsupported object on Undo<Like>: {objectId}", {
          objectId: like.objectId,
        });
      }
    } else if (object instanceof Announce) {
      const sharer = object.actorId;
      const originalPost = object.objectId;
      if (sharer == null || originalPost == null) return;
      await db.transaction(async (tx) => {
        const deleted = await tx
          .delete(posts)
          .where(
            and(
              eq(
                posts.accountId,
                db
                  .select({ id: accounts.id })
                  .from(accounts)
                  .where(eq(accounts.iri, sharer.href)),
              ),
              eq(
                posts.sharingId,
                db
                  .select({ id: posts.id })
                  .from(posts)
                  .where(eq(posts.iri, originalPost.href)),
              ),
            ),
          )
          .returning();
        await tx
          .update(posts)
          .set({
            sharesCount: sql`coalesce(${posts.sharesCount} - ${deleted.length}, 0)`,
          })
          .where(eq(posts.iri, originalPost.href));
      });
    } else {
      inboxLogger.debug("Unsupported object on Undo: {object}", { object });
    }
  });

federation.setObjectDispatcher(Note, "/@{handle}/{id}", async (ctx, values) => {
  const owner = await db.query.accountOwners.findFirst({
    where: like(accountOwners.handle, values.handle),
    with: { account: true },
  });
  if (owner == null) return null;
  const post = await db.query.posts.findFirst({
    where: and(eq(posts.id, values.id), eq(posts.accountId, owner.account.id)),
    with: {
      account: { with: { owner: true } },
      replyTarget: true,
      media: true,
      mentions: { with: { account: true } },
    },
  });
  if (post == null) return null;
  if (post.visibility === "private") {
    const keyOwner = await ctx.getSignedKeyOwner();
    if (keyOwner?.id == null) return null;
    const found = await db.query.follows.findFirst({
      where: and(
        eq(follows.followerId, keyOwner.id.href),
        eq(follows.followingId, owner.id),
      ),
    });
    if (found == null) return null;
  } else if (post.visibility === "direct") {
    const keyOwner = await ctx.getSignedKeyOwner();
    const keyOwnerId = keyOwner?.id;
    if (keyOwnerId == null) return null;
    const found = post.mentions.some((m) => m.account.iri === keyOwnerId.href);
    if (!found) return null;
  }
  return toObject(post, ctx);
});

federation.setNodeInfoDispatcher("/nodeinfo/2.1", async (_ctx) => {
  return {
    software: {
      name: "hollo",
      version: parse(metadata.version),
      repository: new URL("https://github.com/dahlia/hollo"),
    },
    protocols: ["activitypub"],
    usage: {
      users: {
        //TODO
        total: 1,
        activeMonth: 1,
        activeHalfyear: 1,
      },
      localComments: 0,
      localPosts: 0,
    },
  };
});

export default federation;

// cSpell: ignore halfyear
