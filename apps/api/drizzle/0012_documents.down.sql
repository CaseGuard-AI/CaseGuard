-- Reverses 0012_documents.sql. Document rows and their stage log are lost; the files in the blob
-- store and any queued pgboss jobs are not touched (purge them by hand if needed).
DROP TABLE "app"."document_stages";
DROP TABLE "app"."documents";
