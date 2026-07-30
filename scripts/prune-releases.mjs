// Deletes every published release object, for an account that has stopped rendering.
//
// `pruneOldReleases` in the publisher only runs *inside* the render path, so with
// RENDER_OFFICE_COUNT at 0 the objects from the last render run stay in the bucket
// forever — about 1.5 GB across ~1,120 objects, for imagery no client requests. This is
// the one-off that clears them; it is not wired into the workflow, because a run that
// renders prunes itself.
//
// `latest.json` goes with them, deliberately. A manifest that outlives its release points
// at deleted objects, and `PublishedForecastPlot` renders those as broken images rather
// than falling back to the canvas. With the manifest absent, `/api/published-forecast`
// fails, `publishedForecast` stays null, and every view renders live — which is what the
// site already does. The next successful render run writes a fresh one.
//
// Dry run by default. Pass --delete to actually remove anything:
//
//   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=… \
//     node scripts/prune-releases.mjs --delete
//
// The forecast data tier lives under `forecast/`, is never touched here, and is the only
// thing production actually reads — the key filter below is anchored so a stray key
// outside `releases/` can never be selected.
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const apply = process.argv.includes("--delete");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const bucket = required("R2_BUCKET");
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT ?? `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
});

/** Same shape the publisher writes, so nothing else can be matched by accident. */
const RELEASE_KEY = /^releases\/\d{8}T\d{6}Z\//;

const keys = [];
const releases = new Set();
let bytes = 0;
let continuationToken;
do {
  const listing = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: "releases/",
    ContinuationToken: continuationToken,
  }));
  for (const object of listing.Contents ?? []) {
    if (!object.Key || !RELEASE_KEY.test(object.Key)) continue;
    keys.push({ Key: object.Key });
    releases.add(object.Key.split("/")[1]);
    bytes += object.Size ?? 0;
  }
  continuationToken = listing.IsTruncated ? listing.NextContinuationToken : undefined;
} while (continuationToken);

console.error(`${keys.length} objects across ${releases.size} release(s), ${(bytes / 1024 / 1024).toFixed(1)} MB`);
for (const release of [...releases].sort()) console.error(`  ${release}`);

if (!apply) {
  console.log(JSON.stringify({ deleted: false, objects: keys.length, releases: releases.size, megabytes: +(bytes / 1024 / 1024).toFixed(1) }));
  process.exit(0);
}

let deleted = 0;
for (let index = 0; index < keys.length; index += 1000) {
  const batch = keys.slice(index, index + 1000);
  await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
  deleted += batch.length;
  console.error(`deleted ${deleted}/${keys.length}`);
}

// Last, and only once the releases are actually gone: while it exists it is the only
// thing that can tell a client those objects were ever there.
await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key: "latest.json" }], Quiet: true } }));

console.log(JSON.stringify({ deleted: true, objects: deleted, releases: releases.size, megabytes: +(bytes / 1024 / 1024).toFixed(1), manifestRemoved: true }));
