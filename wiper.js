require('dotenv').config();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// CONFIGURATION
const HOMESERVER_URL = process.env.HOMESERVER_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ROOM_ID = process.env.ROOM_ID;
// Parse --days argument
const daysArgIndex = process.argv.findIndex(arg => arg === '--days');
const daysFromArgs = daysArgIndex !== -1 && process.argv[daysArgIndex + 1] !== undefined ? parseInt(process.argv[daysArgIndex + 1]) : null;
const REDACT_DAYS = daysFromArgs !== null ? daysFromArgs : (parseInt(process.env.REDACT_DAYS) || 7);
const PURGE_DAYS = parseInt(process.env.PURGE_DAYS) || 30;
const LIMIT = parseInt(process.env.LIMIT) || 100;
const RATE_LIMIT_DELAY = parseInt(process.env.RATE_LIMIT_DELAY) || 100;

// Check for --commit flag to override dry-run
const DRY_RUN = !process.argv.includes('--commit') && (process.env.DRY_RUN !== 'false');
const DEBUG = process.argv.includes('--debug');

// Validation functions
function validateEnvironment() {
  const required = ['HOMESERVER_URL', 'ADMIN_TOKEN', 'ROOM_ID'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    console.error('Please check your .env file or set these variables.');
    process.exit(1);
  }
}

function validateRoomId(roomId) {
  const roomIdPattern = /^![a-zA-Z0-9._=-]+:[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!roomIdPattern.test(roomId)) {
    console.error(`❌ Invalid room ID format: ${roomId}`);
    console.error('Room ID should be in format: !localpart:domain.tld');
    process.exit(1);
  }
}

function validateToken(token) {
  if (!token || token.length < 10) {
    console.error('❌ Invalid admin token: token appears too short or empty');
    process.exit(1);
  }
  
  // Check for common token prefixes
  const validPrefixes = ['syt_', 'MDAxM', 'MDAx'];
  const hasValidPrefix = validPrefixes.some(prefix => token.startsWith(prefix));
  
  if (!hasValidPrefix) {
    console.warn('⚠️  Warning: Admin token format not recognized, proceeding anyway...');
  }
}

function validateHomeserverUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Protocol must be http or https');
    }
  } catch (err) {
    console.error(`❌ Invalid homeserver URL: ${url}`);
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

const redactCutoffTs = Date.now() - REDACT_DAYS * 24 * 60 * 60 * 1000;
const purgeCutoffTs = Date.now() - PURGE_DAYS * 24 * 60 * 60 * 1000;

const HEADERS = {
  Authorization: `Bearer ${ADMIN_TOKEN}`,
  'Content-Type': 'application/json'
};

async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRetryable = error.code === 'ENOTFOUND' || 
                         error.code === 'ECONNRESET' || 
                         error.code === 'ETIMEDOUT' ||
                         (error.response && [429, 502, 503, 504].includes(error.response.status));
      
      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }
      
      let delay = baseDelay * Math.pow(2, attempt - 1);
      
      // Handle rate limiting (429) with server-specified delay
      if (error.response && error.response.status === 429) {
        const retryAfter = error.response.data?.retry_after_ms || 1000;
        delay = Math.max(delay, retryAfter);
      }
      
      console.warn(`⚠️  Request failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function getOldEvents(roomId) {
  const url = `${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`;
  let params = { dir: 'b', limit: LIMIT };
  const eventsToRedact = [];

  while (true) {
    const resp = await retryWithBackoff(() => 
      axios.get(url, { headers: HEADERS, params, timeout: 30000 })
    );
    const data = resp.data;
    if (DEBUG) console.log(`Response: chunk length=${data.chunk?.length}, start=${data.start}, end=${data.end}`);

    if (!data.chunk || data.chunk.length === 0) break;

    let stopPagination = false;

    for (const event of data.chunk) {
      if (DEBUG) console.log(`Event: type=${event.type}, redacted=${!!event?.unsigned?.redacted_because}, ts=${event.origin_server_ts}`);
      
      // Skip already redacted or redaction events
      if (event?.unsigned?.redacted_because || event.type === 'm.room.redaction') {
        if (DEBUG) console.log(`  Skipping: ${event?.unsigned?.redacted_because ? 'redacted' : 'redaction event'}`);
        continue;
      }

      if ((event.type === 'm.room.message' || event.type === 'm.room.encrypted') && event.origin_server_ts) {
        if (DEBUG) console.log(`  Message event: ts=${event.origin_server_ts}, cutoff=${redactCutoffTs}, include=${event.origin_server_ts < redactCutoffTs}`);
        if (event.origin_server_ts < redactCutoffTs) {
          eventsToRedact.push(event.event_id);
        } else {
          stopPagination = true; // We reached newer messages
        }
      } else {
        if (DEBUG) console.log(`  Skipping: not a message event or missing timestamp`);
      }
    }

    if (stopPagination || !data.end) break;
    params.from = data.end;
  }

  return eventsToRedact;
}

async function redactEvent(roomId, eventId) {
  const url = `${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${eventId}/${uuidv4()}`;
  try {
    await retryWithBackoff(() => 
      axios.put(url, {}, { headers: HEADERS, timeout: 30000 })
    );
    return true;
  } catch (err) {
    if (err.response) {
      console.error(`Failed to redact ${eventId}: HTTP ${err.response.status} - ${err.response.statusText}`);
      console.error(`Response body:`, err.response.data);
    } else if (err.request) {
      console.error(`Failed to redact ${eventId}: No response received - ${err.message}`);
    } else {
      console.error(`Failed to redact ${eventId}: ${err.message}`);
    }
    return false;
  }
}

async function purgeHistory(roomId) {
  const url = `${HOMESERVER_URL}/_synapse/admin/v1/purge_history/${encodeURIComponent(roomId)}`;
  const payload = { purge_up_to_ts: purgeCutoffTs };

  if (DRY_RUN) {
    console.log(`[DRY-RUN] Would purge messages older than ${PURGE_DAYS} days (timestamp: ${purgeCutoffTs})`);
    return;
  }

  try {
    const resp = await retryWithBackoff(() => 
      axios.post(url, payload, { headers: HEADERS, timeout: 30000 })
    );
    console.log('Purge request accepted:', resp.data);
  } catch (err) {
    console.error('Failed to purge history:', err.response ? err.response.data : err.message);
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  // Validate environment and configuration
  validateEnvironment();
  validateHomeserverUrl(HOMESERVER_URL);
  validateRoomId(ROOM_ID);
  validateToken(ADMIN_TOKEN);

  console.log(`Fetching messages older than ${REDACT_DAYS} days for redaction in room ${ROOM_ID}...`);
  const oldEvents = await getOldEvents(ROOM_ID);
  if (DEBUG) console.log('old events', oldEvents);
  const total = oldEvents.length;
  console.log(`Found ${total} events to redact.`);

  if (DRY_RUN) {
    console.log('Dry-run mode enabled. No redactions or purges will be performed.');
    oldEvents.forEach(eventId => console.log(`Would redact: ${eventId}`));
    console.log(`Would purge all events older than ${PURGE_DAYS} days after redaction.`);
    console.log('\n🔹 Run with --commit to execute these changes');
    return;
  }

  console.log('Starting redaction...');
  const startTime = Date.now();

  for (let i = 0; i < total; i++) {
    const eventId = oldEvents[i];
    const success = await redactEvent(ROOM_ID, eventId);

    const elapsed = (Date.now() - startTime) / 1000;
    const remaining = ((elapsed / (i + 1)) * (total - i - 1)).toFixed(0);
    const percent = (((i + 1) / total) * 100).toFixed(2);

    console.log(`[${i + 1}/${total}] ${success ? 'OK' : 'FAIL'} - ${eventId} | ${percent}% done, ETA ${remaining}s`);

    await delay(RATE_LIMIT_DELAY);
  }

  console.log(`Redaction complete. Now purging messages older than ${PURGE_DAYS} days...`);
  await purgeHistory(ROOM_ID);

  console.log('All tasks completed.');
}

main().catch(err => console.error('Error:', err));

