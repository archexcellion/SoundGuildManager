# SoundGuildManager (SGM)

**SoundGuildManager** is a queue-based Discord voice bot with slash commands. It streams audio from YouTube videos and playlists and can search YouTube from a song name.

## Features

- `/play <link or search>` — YouTube video, YouTube playlist, or song name
- `/pause`, `/resume`, `/skip`, `/stop`
- `/queue`, `/nowplaying`
- Rich now-playing cards with video artwork and playback buttons
- Separate queues per Discord server
- Automatic disconnect after the queue has been idle

## Set up Discord

1. Create an application named **SoundGuildManager** in the [Discord Developer Portal](https://discord.com/developers/applications), then add a bot.
2. Copy the bot token and application ID into `.env` (use `.env.example` as the template).
3. In **OAuth2 → URL Generator**, select `bot` and `applications.commands`.
4. Give the bot `View Channels`, `Send Messages`, `Connect`, and `Speak`, then use the generated URL to invite it.
5. For instant command registration during development, put your server ID in `DISCORD_GUILD_ID`. Global commands can take time to appear.

To rename an existing bot, open its application in the Developer Portal, select **Bot**, change its username to **SoundGuildManager**, and save. You can also update the application name under **General Information**.

## Run with Docker (recommended)

```bash
cp .env.example .env
# Fill in .env, then run:
./run.sh
```

Use `./run.sh logs` to follow output or `./run.sh check` to run validation.

If Docker is missing on Ubuntu or Debian, `./run.sh` downloads and installs Docker Engine plus the Compose plugin from Docker's official installer. You can install Docker and build the image with all application requirements without starting the bot using:

```bash
./run.sh install
```

On Linux, the installer requests `sudo` access and adds your account to the `docker` group. Log out and back in afterward to use Docker without `sudo`. On macOS, install [Docker Desktop](https://docs.docker.com/desktop/) manually.

### Windows

Open the project in **Git Bash** and run the same launcher:

```bash
cp .env.example .env
# Fill in .env, then run:
./run.sh
```

If Docker is missing, the script downloads and installs Docker Desktop through `winget`, starts it, and waits for the container engine. Administrator approval may be required. The Docker build installs the Node.js packages and `yt-dlp` required by the bot, so no separate `npm install` is needed.

## Run directly

Install Node.js 22.12 or newer and `yt-dlp`. FFmpeg is bundled through the `ffmpeg-static` npm package.

```bash
cp .env.example .env
./run.sh local
```

Keep `yt-dlp` current because YouTube changes frequently. If it is installed somewhere unusual, set `YTDLP_PATH` in `.env`.

## Configuration

| Option | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Yes | — | Secret token used to sign in as the bot |
| `DISCORD_CLIENT_ID` | Yes | — | Public Discord application ID used to register commands |
| `DISCORD_GUILD_ID` | No | Global | Registers commands immediately in one development server |
| `YTDLP_PATH` | No | `yt-dlp` | Executable name or absolute path for yt-dlp |
| `MAX_PLAYLIST_SIZE` | No | `100` | Maximum number of tracks added from one playlist |
| `IDLE_DISCONNECT_SECONDS` | No | `300` | Delay before leaving voice after the queue ends |

The launcher supports `docker`, `install`, `local`, `check`, and `logs` modes. Run `./run.sh --help` for examples.

## Notes

- A song-name search plays the first YouTube result, so an occasional match may be a cover or alternate version.
- YouTube may rate-limit a heavily used public bot. This project is best suited to a private or small community bot.
- Only stream content you are permitted to access, and follow Discord and YouTube terms.
