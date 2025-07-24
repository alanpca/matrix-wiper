# Matrix Wiper

A Node.js script to automatically redact (delete) old messages from Matrix rooms and purge them from the server database.

## Features

- Redacts messages older than a specified number of days
- Supports both regular and encrypted rooms
- Handles rate limiting gracefully with exponential backoff
- Dry-run mode by default for safety
- Purges old messages from server database after redaction
- Debug mode for troubleshooting

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```

## Configuration

Create a `.env` file with the following variables:

```env
HOMESERVER_URL=https://your-matrix-server.com
ADMIN_TOKEN=your_admin_access_token
ROOM_ID=!your-room-id:server.com
REDACT_DAYS=7
PURGE_DAYS=30
LIMIT=100
RATE_LIMIT_DELAY=500
```

### Configuration Options

- `HOMESERVER_URL`: Your Matrix homeserver URL
- `ADMIN_TOKEN`: Admin access token (or user token for someone in the room)
- `ROOM_ID`: The room ID to clean up (format: `!localpart:domain.tld`)
- `REDACT_DAYS`: Days after which messages should be redacted (default: 7)
- `PURGE_DAYS`: Days after which messages should be purged from database (default: 30)
- `LIMIT`: Number of messages to fetch per API call (default: 100)
- `RATE_LIMIT_DELAY`: Delay between requests in milliseconds (default: 500)

## Usage

### Dry Run (Safe Mode)
```bash
node wiper.js
```
Shows what would be deleted without actually doing it.

### Actually Delete Messages
```bash
node wiper.js --commit
```

### Override Redaction Days
```bash
node wiper.js --days 30 --commit
```

### Debug Mode
```bash
node wiper.js --debug --commit
```

## How It Works

1. **Fetch Messages**: Retrieves messages from the specified room using the Matrix Client API
2. **Filter by Age**: Identifies messages older than the specified number of days
3. **Redact Messages**: Sends redaction events to mark messages as deleted
4. **Purge History**: Uses Synapse admin API to permanently remove old messages from database

## Rate Limiting

The script handles Matrix server rate limits automatically. To reduce rate limiting:

1. Increase `RATE_LIMIT_DELAY` in your `.env` file
2. Configure your Synapse server for higher admin redaction limits in `homeserver.yaml`:

```yaml
rc_admin_redaction:
  per_second: 10000
  burst_count: 100000
```

## Requirements

- Node.js
- Access to a Matrix homeserver with admin privileges
- Admin access token or user token for someone in the target room

## Safety Features

- Dry-run mode by default (requires `--commit` to actually delete)
- Validates environment variables and configuration
- Validates room ID format
- Checks admin token format
- Handles network errors with retry logic

## Supported Message Types

- Regular messages (`m.room.message`)
- Encrypted messages (`m.room.encrypted`)

## Author

Developed by Alan P. Laudicina from [Opreto](https://www.opreto.com)

## Contributing

Contributions are welcome! Open a PR.

## License

MIT License