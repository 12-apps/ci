// The fleet's queue, kept from the webhooks instead of read from the API.
//
// Every `workflow_job` delivery says which job it is and what happened to it:
// `queued` puts the job on the queue, `in_progress` and `completed` take it
// off. Kept in a DynamoDB table, one item per job, the queue costs no GitHub
// request to count. Reading it from the API instead (the runs, each run's
// jobs, the runners) took about fourteen requests a delivery and emptied the
// token's 5,000 an hour within 12-30 minutes of a busy hour (2026-09-28/29):
// the scaler then answered 403 and launched nothing until the hour turned.
//
// A delivery can be lost (GitHub does not retry one the function failed), so
// at most every `reconcileSeconds` one evaluation reads the queue from the API
// and makes the table agree. An item never taken off expires with the table's
// TTL. index.mjs wires the client; the tests fake it.

const JOB = "j#";
const RECONCILE = "#reconcile";
const SETTLE = "#settle";

/**
 * @param {object} cfg
 * @param {{ send(command: object): Promise<any> }} cfg.client a DynamoDBClient
 * @param {Record<string, new (input: object) => object>} cfg.commands PutItem, DeleteItem, Scan and UpdateItem commands
 * @param {string} cfg.table
 * @param {() => number} [cfg.now]
 * @param {number} [cfg.ttlSeconds] how long an item not taken off lives
 * @param {number} [cfg.reconcileSeconds]
 * @param {number} [cfg.graceSeconds] an item newer than this survives a reconcile that does not list it
 */
export function makeQueue({ client, commands, table, now = () => Date.now(), ttlSeconds = 6 * 3600, reconcileSeconds = 600, graceSeconds = 120 }) {
  const { PutItemCommand, DeleteItemCommand, ScanCommand, UpdateItemCommand } = commands;
  const put = (job) => client.send(new PutItemCommand({
    TableName: table,
    Item: { id: { S: JOB + job }, at: { N: String(now()) }, expires: { N: String(Math.floor(now() / 1000) + ttlSeconds) } },
  }));
  const drop = (job) => client.send(new DeleteItemCommand({ TableName: table, Key: { id: { S: JOB + job } } }));

  async function items() {
    const found = [];
    let start;
    do {
      const out = await client.send(new ScanCommand({
        TableName: table, ConsistentRead: true, ExclusiveStartKey: start,
        FilterExpression: "begins_with(id, :j)", ExpressionAttributeValues: { ":j": { S: JOB } },
      }));
      for (const it of out.Items ?? []) found.push({ job: it.id.S.slice(JOB.length), at: Number(it.at?.N ?? 0) });
      start = out.LastEvaluatedKey;
    } while (start);
    return found;
  }

  return {
    add: (job) => put(String(job)),
    remove: (job) => drop(String(job)),
    async count() {
      return (await items()).length;
    },
    // True for the one evaluation that should read the API this interval.
    async claimReconcile() {
      try {
        await client.send(new UpdateItemCommand({
          TableName: table, Key: { id: { S: RECONCILE } },
          UpdateExpression: "SET #at = :now",
          ConditionExpression: "attribute_not_exists(#at) OR #at < :due",
          ExpressionAttributeNames: { "#at": "at" },
          ExpressionAttributeValues: { ":now": { N: String(now()) }, ":due": { N: String(now() - reconcileSeconds * 1000) } },
        }));
        return true;
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") return false;
        throw e;
      }
    },
    // True for the one evaluation that waits `seconds` before launching
    // (scale.mjs, settling); the others leave the launch to it.
    async claimSettle(seconds) {
      try {
        await client.send(new UpdateItemCommand({
          TableName: table, Key: { id: { S: SETTLE } },
          UpdateExpression: "SET #at = :now",
          ConditionExpression: "attribute_not_exists(#at) OR #at < :due",
          ExpressionAttributeNames: { "#at": "at" },
          ExpressionAttributeValues: { ":now": { N: String(now()) }, ":due": { N: String(now() - seconds * 1000) } },
        }));
        return true;
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") return false;
        throw e;
      }
    },
    // Make the table hold exactly the jobs the API lists, keeping items added
    // in the last `graceSeconds` (a job can be delivered before it is listed).
    async replace(jobs) {
      const want = new Set(jobs.map(String));
      const have = await items();
      const stale = have.filter((i) => !want.has(i.job) && now() - i.at > graceSeconds * 1000);
      const known = new Set(have.map((i) => i.job));
      const missing = [...want].filter((j) => !known.has(j));
      await Promise.all([...stale.map((i) => drop(i.job)), ...missing.map(put)]);
      return { removed: stale.length, added: missing.length };
    },
  };
}
