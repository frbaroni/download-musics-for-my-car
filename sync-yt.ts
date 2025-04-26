import { execSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import pLimit from 'p-limit';
import blessed from 'blessed';
import { SingleBar, Presets } from 'cli-progress';

const playlistUrls = [
    'https://music.youtube.com/playlist?list=PL6YVnWd7IiQVHepsVJGTO7hodBqMeRg2t', // Topz
];

const videoUrls = [
    'https://youtube.com/watch?v=KtPGD9nakhk', // Sander van Doorn - Purple Haze - Natural One 2019
    'https://youtube.com/watch?v=h5XT15tMM2A', // Falling Star Compilation 4
    'https://youtube.com/watch?v=Su-VS5f_NjE', // Nifra - Ear-Gasmic Boat Party 2021
    'https://youtube.com/watch?v=hrPwWVz4odE', // Armin van Buuren - Tomorrowland 2022 WE1
    'https://youtube.com/watch?v=v7PJqCTX5ZE', // Armin van Buuren - Tomorrowland 2022 WE2
];

// Directory to save the downloaded music
const downloadDirectory = path.join(__dirname, "/Downloaded");
const cacheFile = path.join(__dirname, "/downloaded_tracks.json");
const errorsFile = path.join(__dirname, "/errors.txt");
const fallbackFormat = 'bestvideo+bestaudio/best';

interface Cache {
    [key: string]: {
        downloaded: boolean;
        title?: string;
        error?: string;
        retries?: number;
        lastAttempt?: string;
    };
}

interface TrackInfo {
    url: string;
    title: string;
    status: 'pending' | 'downloading' | 'transcoding' | 'completed' | 'error';
    error?: string;
}

let cache: Cache = {};
let errors: Cache = {};
let totalTracks = 0;
let completedTracks = 0;
let errorTracks = 0;

// Initialize blessed screen
const screen = blessed.screen({
    smartCSR: true,
    title: 'YouTube Music Downloader'
});

// Create main progress bar
const progressBar = blessed.progressbar({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    border: 'line',
    style: {
        fg: 'blue',
        bg: 'default',
        border: {
            fg: 'default'
        }
    },
    filled: 0
});

// Create log box
const logBox = blessed.log({
    parent: screen,
    top: 4,
    left: 0,
    width: '100%',
    height: '80%',
    border: 'line',
    scrollable: true,
    mouse: true,
    keys: true,
    vi: true,
    alwaysScroll: true,
    scrollbar: {
        ch: ' ',
        track: {
            bg: 'cyan'
        },
        style: {
            inverse: true
        }
    }
});

// Create status box
const statusBox = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    border: 'line',
    content: 'Ready to start...'
});

// Load cache
if (fs.existsSync(cacheFile)) {
    cache = fs.readJsonSync(cacheFile);
}

if (fs.existsSync(errorsFile)) {
    errors = fs.readJsonSync(errorsFile);
}

function updateStatus() {
    const progress = (completedTracks / totalTracks) * 100;
    progressBar.setProgress(progress);
    statusBox.setContent(`Total: ${totalTracks} | Completed: ${completedTracks} | Errors: ${errorTracks} | Remaining: ${totalTracks - completedTracks - errorTracks}`);
    screen.render();
}

function log(message: string) {
    logBox.log(message);
    screen.render();
}

function sanitizeFilename(filename: string): string {
    return filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

async function downloadTrack(url: string): Promise<void> {
    if (cache[url]?.downloaded) {
        log(`Skipping already downloaded track: ${url}`);
        completedTracks++;
        updateStatus();
        return;
    }

    if (cache[url]?.retries && cache[url].retries >= 3) {
        log(`Skipping track with too many retries: ${url}`);
        errorTracks++;
        updateStatus();
        return;
    }

    try {
        log(`Fetching metadata for: ${url}`);
        const metadata = JSON.parse(execSync(`yt-dlp -j ${url}`, { encoding: 'utf-8' }));
        const title = metadata.title;
        const sanitizedTitle = sanitizeFilename(title);
        const outputPath = path.join(downloadDirectory, `${sanitizedTitle}.mp4`);

        log(`Downloading: ${title}`);
        execSync(`yt-dlp -i --no-overwrites -f "${fallbackFormat}" -o "${outputPath}" ${url}`, { stdio: 'inherit' });

        log(`Transcoding: ${title}`);
        const tempOutput = path.join(downloadDirectory, `${sanitizedTitle}_temp.mp4`);
        execSync(`ffmpeg -y -i "${outputPath}" -c:v libx264 -profile:v baseline -level 3.0 -maxrate 2M -bufsize 2M -vf "scale=1280:720" -c:a aac -b:a 192k "${tempOutput}"`, { stdio: 'inherit' });

        fs.removeSync(outputPath);
        fs.renameSync(tempOutput, outputPath);

        cache[url] = {
            downloaded: true,
            title: title
        };
        fs.writeJsonSync(cacheFile, cache, { spaces: 2 });

        completedTracks++;
        updateStatus();
        log(`Completed: ${title}`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Error downloading ${url}: ${errorMessage}`);
        
        cache[url] = {
            downloaded: false,
            error: errorMessage,
            retries: (cache[url]?.retries || 0) + 1,
            lastAttempt: new Date().toISOString()
        };
        fs.writeJsonSync(cacheFile, cache, { spaces: 2 });
        
        errorTracks++;
        updateStatus();
    }
}

async function getTracksFromPlaylist(url: string): Promise<string[]> {
    try {
        const output = execSync(`yt-dlp --flat-playlist -J ${url}`, { encoding: 'utf-8' });
        const playlistData = JSON.parse(output);
        return playlistData.entries.map((entry: any) => `https://youtube.com/watch?v=${entry.id}`);
    } catch (error) {
        log(`Failed to fetch playlist: ${url}\nError: ${error}`);
        return [];
    }
}

async function main() {
    // Create download directory if it doesn't exist
    fs.ensureDirSync(downloadDirectory);

    // Get all tracks
    const allTracks: string[] = [];
    for (const playlistUrl of playlistUrls) {
        const trackUrls = await getTracksFromPlaylist(playlistUrl);
        allTracks.push(...trackUrls);
    }
    allTracks.push(...videoUrls);
    totalTracks = allTracks.length;

    // Initialize progress
    updateStatus();

    // Set up parallel processing
    const limit = pLimit(os.cpus().length);
    const promises = allTracks.map(url => limit(() => downloadTrack(url)));

    // Wait for all downloads to complete
    await Promise.all(promises);

    // Final status
    log(`\nDownload complete!`);
    log(`Total tracks: ${totalTracks}`);
    log(`Completed: ${completedTracks}`);
    log(`Errors: ${errorTracks}`);
    log(`Remaining: ${totalTracks - completedTracks - errorTracks}`);

    // Keep the screen open until user presses 'q'
    screen.key(['q', 'C-c'], () => process.exit(0));
}

main().catch(error => {
    log(`Fatal error: ${error}`);
    process.exit(1);
});