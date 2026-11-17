-- Copied verbatim from the blog repo db/migrations (001 and the blog_documents index from 002), commit 4b6fb7f.
-- JSONB retains immutable launch snapshots and the complete historical record.
CREATE TABLE blog_documents (
    namespace text NOT NULL DEFAULT 'blog',
    path text NOT NULL,
    collection_path text NOT NULL,
    id text NOT NULL,
    data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
    version bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (namespace, path),
    CHECK (path = collection_path || '/' || id),
    CHECK (id <> '' AND position('/' in id) = 0)
);
CREATE INDEX blog_documents_collection ON blog_documents(namespace, collection_path, id COLLATE "C");
CREATE INDEX blog_documents_data ON blog_documents USING gin (data jsonb_path_ops);
CREATE INDEX blog_documents_status ON blog_documents(namespace, collection_path, (data->'status'));
CREATE INDEX blog_documents_slug ON blog_documents(namespace, collection_path, (data->'slug'));
CREATE INDEX blog_documents_category ON blog_documents(namespace, collection_path, (data->'category'));
CREATE INDEX blog_documents_email ON blog_documents(namespace, collection_path, (data->'email'));
CREATE INDEX blog_documents_post ON blog_documents(namespace, collection_path, (data->'postId'));

-- Timestamp query values use exact numeric nanoseconds, not float milliseconds.
CREATE FUNCTION blog_sort_value(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN value->>'__blogTimestamp' = 'true'
    THEN to_jsonb((value->>'seconds')::numeric * 1000000000 + (value->>'nanoseconds')::numeric)
    ELSE value END
$$;
CREATE INDEX blog_documents_created ON blog_documents(namespace, collection_path, blog_sort_value(data->'createdAt'), id COLLATE "C");
CREATE INDEX blog_documents_published ON blog_documents(namespace, collection_path, blog_sort_value(data->'publishDate'), id COLLATE "C");
CREATE INDEX blog_documents_group ON blog_documents(namespace, (regexp_replace(collection_path, '^.*/', '')), path COLLATE "C");
