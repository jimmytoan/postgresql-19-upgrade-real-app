-- Synthetic data in the blog's document shapes. Deterministic: every value is derived
-- from md5 of the row number, so PostgreSQL 18 and 19 build identical logical data.
-- psql variables: posts, events, subs, embeddings, conversations.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION lab_h(seed bigint, j int) RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT ('x' || substr(md5(seed::text || ':' || j::text), 1, 7))::bit(28)::int $$;
CREATE OR REPLACE FUNCTION lab_text(seed bigint, n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH w AS (SELECT string_to_array('the of and to in is that for it as with on be at by this have from or one had not but what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part postgres index query table vacuum upgrade latency agent model token context memory cache server deploy docker release planner tuple buffer lock commit replica backup restore schema migration benchmark', ' ') a)
  SELECT string_agg(a[1 + lab_h(seed, j) % array_length(a, 1)], ' ' ORDER BY j) FROM w, generate_series(1, n) j $$;
CREATE OR REPLACE FUNCTION lab_ts(s bigint) RETURNS jsonb LANGUAGE sql IMMUTABLE AS
$$ SELECT jsonb_build_object('__blogTimestamp', true, 'seconds', s, 'nanoseconds', 0) $$;

INSERT INTO blog_documents(namespace, path, collection_path, id, data)
SELECT 'blog', 'blog-posts/' || id, 'blog-posts', id, jsonb_build_object(
    'title', initcap(lab_text(i, 8)), 'slug', 'post-' || i,
    'status', CASE WHEN i % 10 = 0 THEN 'draft' ELSE 'published' END,
    'category', (ARRAY['technology','ai','career','finance','learning','tools'])[1 + i % 6],
    'tags', jsonb_build_array('t' || lab_h(i, -1) % 40, 't' || lab_h(i, -2) % 40, 't' || lab_h(i, -3) % 40),
    'excerpt', lab_text(i + 1000000, 40),
    'content', lab_text(i + 2000000, 600 + lab_h(i, -4) % 1900),
    'author', 'Lab Author',
    'publishDate', lab_ts(1600000000 + i * 3600::bigint + lab_h(i, -5) % 3600),
    'createdAt', lab_ts(1600000000 + i * 3600::bigint),
    'updatedAt', lab_ts(1600000000 + i * 3600::bigint + 86400),
    'analytics', jsonb_build_object('views', lab_h(i, -6) % 100000, 'likes', lab_h(i, -7) % 500),
    'seo', jsonb_build_object('metaTitle', initcap(lab_text(i, 8)), 'metaDescription', lab_text(i + 3000000, 25),
                              'keywords', jsonb_build_array('k' || lab_h(i, -8) % 200, 'k' || lab_h(i, -9) % 200)))
FROM (SELECT i, 'p' || lpad(i::text, 7, '0') AS id FROM generate_series(1, :posts) i) s;

INSERT INTO blog_documents(namespace, path, collection_path, id, data)
SELECT 'blog', 'analytics-events/' || id, 'analytics-events', id, jsonb_build_object(
    'type', (ARRAY['pageview','pageview','pageview','click','scroll','share'])[1 + lab_h(i, 1) % 6],
    'postId', 'p' || lpad((1 + lab_h(i, 2) % :posts)::text, 7, '0'),
    'sessionId', md5('s' || (lab_h(i, 3) % (:events / 8 + 1))),
    'path', '/technology/post-' || (1 + lab_h(i, 2) % :posts),
    'referrer', (ARRAY['https://www.google.com/','https://news.ycombinator.com/','https://www.linkedin.com/','',''])[1 + lab_h(i, 4) % 5],
    'userAgent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 lab/' || lab_h(i, 5) % 30,
    'durationMs', lab_h(i, 6) % 180000,
    'createdAt', lab_ts(1700000000 + i * 7::bigint))
FROM (SELECT i, 'e' || lpad(i::text, 9, '0') AS id FROM generate_series(1, :events) i) s;

INSERT INTO blog_documents(namespace, path, collection_path, id, data)
SELECT 'blog', 'newsletter-subscribers/' || id, 'newsletter-subscribers', id, jsonb_build_object(
    'email', 'user' || i || '@example.test',
    'status', CASE WHEN i % 12 = 0 THEN 'unsubscribed' ELSE 'active' END,
    'source', (ARRAY['footer','popup','lead-magnet','import'])[1 + lab_h(i, 11) % 4],
    'tags', jsonb_build_array('t' || lab_h(i, 12) % 40),
    'createdAt', lab_ts(1650000000 + i * 600::bigint))
FROM (SELECT i, 's' || lpad(i::text, 8, '0') AS id FROM generate_series(1, :subs) i) s;

INSERT INTO blog_documents(namespace, path, collection_path, id, data)
SELECT 'blog', 'content-embeddings/' || id, 'content-embeddings', id, jsonb_build_object(
    'postId', 'p' || lpad((1 + (i - 1) % :posts)::text, 7, '0'), 'chunkIndex', (i - 1) / :posts,
    'text', lab_text(i + 4000000, 120), 'model', 'lab-embedding-768',
    'embedding', (SELECT jsonb_agg(round((lab_h(i, j) % 20001 - 10000) / 10000.0, 5) ORDER BY j) FROM generate_series(1, 768) j),
    'updatedAt', lab_ts(1760000000 + i))
FROM (SELECT i, 'c' || lpad(i::text, 7, '0') AS id FROM generate_series(1, :embeddings) i) s;

INSERT INTO blog_documents(namespace, path, collection_path, id, data)
SELECT 'blog', 'ai-conversations/' || id, 'ai-conversations', id, jsonb_build_object(
    'sessionId', md5('c' || i),
    'messages', (SELECT jsonb_agg(jsonb_build_object('role', CASE WHEN m % 2 = 1 THEN 'user' ELSE 'assistant' END,
                    'content', lab_text(i * 10::bigint + m + 5000000, 30 + m * 40)) ORDER BY m) FROM generate_series(1, 6) m),
    'createdAt', lab_ts(1750000000 + i * 60::bigint))
FROM (SELECT i, 'a' || lpad(i::text, 7, '0') AS id FROM generate_series(1, :conversations) i) s;

VACUUM (ANALYZE) blog_documents;
