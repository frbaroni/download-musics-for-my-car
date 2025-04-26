# YouTube Music Downloader for Car Multimedia

A TypeScript script for downloading and optimizing YouTube music videos with maximum compatibility for old car multimedia systems.

## Features

### Download & Processing
- Parallel downloads using all available CPU cores
- Automatic video optimization for car multimedia systems:
  - H.264 baseline profile (level 3.0)
  - 720p resolution with 2Mbps bitrate limit
  - AAC audio at 192kbps for high quality
- Maintains maximum audio quality while ensuring compatibility
- Smart file naming using video titles
- Support for both individual videos and playlists

### User Interface
- Beautiful Terminal UI with:
  - Overall progress bar
  - Real-time status updates
  - Detailed logging area for troubleshooting
  - Current operation status
  - Download/error/remaining counters

### Error Handling & Recovery
- Automatic retry system (3 attempts per track)
- Detailed error logging with timestamps
- Continues processing on errors
- Smart caching system to resume interrupted downloads
- Single JSON file for tracking progress and errors

## Requirements

- Node.js and npm/yarn
- yt-dlp (YouTube downloader)
- ffmpeg (for video transcoding)

## Installation

1. Clone this repository
2. Install dependencies:
   ```
   yarn install
   ```
3. Make sure yt-dlp and ffmpeg are installed and in your PATH
   ```
   yarn check
   ```

## Usage

1. Edit the `sync-yt.ts` file to add your playlists and videos
2. Run the script:
   ```
   yarn start
   ```

## Configuration

You can customize the following in the `config` object:
- `playlistUrls`: Array of YouTube playlist URLs
- `videoUrls`: Array of individual YouTube video URLs
- `maxRetries`: Number of retry attempts for failed downloads
- `concurrency`: Number of parallel downloads (defaults to CPU core count)
- `videoFormat`: Video encoding parameters for car multimedia compatibility

## Controls

- `q` or `Ctrl+C`: Exit the application
- Arrow keys: Navigate the log

## Output Files

- Downloaded videos: `./Downloaded/`
- Cache file: `./downloaded_tracks.json`
- Error log: `./errors.json`
