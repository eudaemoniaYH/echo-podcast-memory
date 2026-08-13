import { ApplePodcastsClient } from "../connectors/apple-podcasts.js";

const databasePath = process.argv[2];

try {
  const client = new ApplePodcastsClient(databasePath ? { databasePath } : {});
  process.stdout.write(JSON.stringify(client.getHistory()));
} catch (error) {
  process.stderr.write(error?.message || String(error));
  process.exitCode = 1;
}
