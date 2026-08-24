export type CommunityPostRecord = {
  id: string;
  authorId: string | null;
  authorName: string;
  authorBusiness: string;
  initials: string;
  space: string;
  title: string;
  body: string;
  reactionCount: number;
  commentCount: number;
  createdAt: Date;
  likedByViewer: boolean;
};

async function db() {
  const { getReadyDb } = await import("@/lib/db/client");
  return getReadyDb();
}

export async function listCommunityPosts(viewerId: string | null, limit = 50): Promise<CommunityPostRecord[]> {
  const database = await db();
  const rows = viewerId
    ? await database`
        SELECT p.*, EXISTS (
          SELECT 1 FROM community_reactions r WHERE r.post_id = p.id AND r.user_id = ${viewerId}
        ) AS "likedByViewer"
        FROM community_posts p WHERE p.status = 'published'
        ORDER BY p.created_at DESC LIMIT ${limit}
      `
    : await database`
        SELECT p.*, FALSE AS "likedByViewer"
        FROM community_posts p WHERE p.status = 'published'
        ORDER BY p.created_at DESC LIMIT ${limit}
      `;
  return rows.map((row) => ({
    id: String(row.id),
    authorId: row.author_id ? String(row.author_id) : null,
    authorName: String(row.author_name),
    authorBusiness: String(row.author_business),
    initials: String(row.initials),
    space: String(row.space),
    title: String(row.title),
    body: String(row.body),
    reactionCount: Number(row.reaction_count),
    commentCount: Number(row.comment_count),
    createdAt: new Date(row.created_at as string),
    likedByViewer: Boolean(row.likedByViewer),
  }));
}

export async function createCommunityPost(input: {
  authorId: string;
  authorName: string;
  authorBusiness: string;
  initials: string;
  space: string;
  title: string;
  body: string;
}) {
  const database = await db();
  const [row] = await database`
    INSERT INTO community_posts (author_id, author_name, author_business, initials, space, title, body)
    VALUES (${input.authorId}, ${input.authorName}, ${input.authorBusiness}, ${input.initials}, ${input.space}, ${input.title}, ${input.body})
    RETURNING id
  `;
  return String(row.id);
}

/** Toggles the viewer's like and keeps the denormalized count in sync. */
export async function toggleCommunityReaction(postId: string, userId: string): Promise<{ liked: boolean; reactionCount: number }> {
  const database = await db();
  const removed = await database`
    DELETE FROM community_reactions WHERE post_id = ${postId} AND user_id = ${userId}
    RETURNING post_id
  `;
  if (removed.length === 0) {
    const inserted = await database`
      INSERT INTO community_reactions (post_id, user_id)
      VALUES (${postId}, ${userId})
      ON CONFLICT (post_id, user_id) DO NOTHING
      RETURNING post_id
    `;
    if (inserted.length > 0) {
      const [row] = await database`UPDATE community_posts SET reaction_count = reaction_count + 1 WHERE id = ${postId} RETURNING reaction_count`;
      return { liked: true, reactionCount: Number(row.reaction_count) };
    }
  } else {
    const [row] = await database`UPDATE community_posts SET reaction_count = GREATEST(reaction_count - 1, 0) WHERE id = ${postId} RETURNING reaction_count`;
    return { liked: false, reactionCount: Number(row.reaction_count) };
  }
  const [row] = await database`SELECT reaction_count FROM community_posts WHERE id = ${postId}`;
  return { liked: false, reactionCount: Number(row?.reaction_count ?? 0) };
}
