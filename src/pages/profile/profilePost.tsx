import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import Layout from "../../components/Layout.tsx";
import { Post as PostView } from "../../components/Post.tsx";
import db from "../../db.ts";
import {
  type Account,
  type Medium,
  type Poll,
  type PollOption,
  type Post,
  accountOwners,
  posts,
} from "../../schema.ts";

const profilePost = new Hono();
profilePost.get<"/:handle{@[^/]+}/:id">(async (c) => {
  let handle = c.req.param("handle");
  const postId = c.req.param("id");
  if (handle.startsWith("@")) handle = handle.substring(1);
  const post = await db.query.posts.findFirst({
    where: and(
      eq(
        posts.accountId,
        db
          .select({ id: accountOwners.id })
          .from(accountOwners)
          .where(eq(accountOwners.handle, handle)),
      ),
      eq(posts.id, postId),
      or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
    ),
    with: {
      account: true,
      media: true,
      poll: { with: { options: true } },
      sharing: {
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          replyTarget: { with: { account: true } },
        },
      },
      replyTarget: { with: { account: true } },
      replies: {
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          sharing: {
            with: {
              account: true,
              media: true,
              poll: { with: { options: true } },
              replyTarget: { with: { account: true } },
            },
          },
          replyTarget: { with: { account: true } },
        },
      },
    },
  });
  if (post == null) return c.notFound();
  return c.html(<PostPage post={post} />);
});

interface PostPageProps {
  post: Post & {
    account: Account;
    media: Medium[];
    poll: (Poll & { options: PollOption[] }) | null;
    sharing:
      | (Post & {
          account: Account;
          media: Medium[];
          poll: (Poll & { options: PollOption[] }) | null;
          replyTarget: (Post & { account: Account }) | null;
        })
      | null;
    replyTarget: (Post & { account: Account }) | null;
    replies: (Post & {
      account: Account;
      media: Medium[];
      poll: (Poll & { options: PollOption[] }) | null;
      sharing:
        | (Post & {
            account: Account;
            media: Medium[];
            poll: (Poll & { options: PollOption[] }) | null;
            replyTarget: (Post & { account: Account }) | null;
          })
        | null;
      replyTarget: (Post & { account: Account }) | null;
    })[];
  };
}

const PostPage = ({ post }: PostPageProps) => {
  const summary =
    post.summary ??
    ((post.content ?? "").length > 30
      ? `${(post.content ?? "").substring(0, 30)}…`
      : post.content ?? "");
  return (
    <Layout
      title={`${summary} — ${post.account.name}`}
      shortTitle={summary}
      description={post.summary ?? post.content}
      imageUrl={post.account.avatarUrl}
      url={post.url ?? post.iri}
    >
      <PostView post={post} />
      {post.replies.map((reply) => (
        <PostView post={reply} />
      ))}
    </Layout>
  );
};

export default profilePost;
