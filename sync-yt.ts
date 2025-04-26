import { execSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import blessed from 'blessed';
import chalk from 'chalk';
// Using require for p-limit since it's a CommonJS module in our setup
const pLimit = require('p-limit');

// Configuration
const config = {
    playlistUrls: [
        'https://youtube.com/playlist?list=PL6YVnWd7IiQVHepsVJGTO7hodBqMeRg2t', // Topz
    ],
    videoUrls: [
        'https://youtube.com/watch?v=KtPGD9nakhk', // Sander van Doorn - Purple Haze - Natural One 2019
        'https://youtube.com/watch?v=h5XT15tMM2A', // Falling Star Compilation 4
        'https://youtube.com/watch?v=Su-VS5f_NjE', // Nifra - Ear-Gasmic Boat Party 2021
        'https://youtube.com/watch?v=hrPwWVz4odE', // Armin van Buuren - Tomorrowland 2022 WE1
        'https://youtube.com/watch?v=v7PJqCTX5ZE', // Armin van Buuren - Tomorrowland 2022 WE2
    ],
    maxRetries: 3,
    concurrency: os.cpus().length,
    videoFormat: {
        codec: 'libx264',
        profile: 'baseline',
        level: '3.0',
        resolution: '1280:720',
        maxRate: '2M',
        bufSize: '2M',
        audioCodec: 'aac',
        audioBitrate: '192k'
    }
};

// Directory to save the downloaded music
const downloadDirectory = path.join(__dirname, "/Downloaded");
const cacheFile = path.join(__dirname, "/downloaded_tracks.json");
const errorsFile = path.join(__dirname, "/errors.json");
const fallbackFormat = 'bestvideo+bestaudio/best';

interface Cache {
    [key: string]: {
        downloaded: boolean;
        title?: string;
        error?: string;
        retries?: number;
        lastAttempt?: string;
        timestamp?: string;
    };
}

interface TrackInfo {
    url: string;
    title: string;
    status: 'pending' | 'downloading' | 'transcoding' | 'completed' | 'error';
    error?: string;
    progress?: number;
    size?: string;
    eta?: string;
}

let cache: Cache = {};
let errors: Cache = {};
let totalTracks = 0;
let completedTracks = 0;
let errorTracks = 0;

// Initialize blessed screen
const screen = blessed.screen({
    smartCSR: true,
    title: 'YouTube Music Downloader for Car Multimedia'
});

// Create header
const headerBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: chalk.bold.cyan(' 🎵 YouTube Music Downloader for Car Multimedia 🚗'),
    border: 'line',
    style: {
        border: {
            fg: 'cyan'
        }
    }
});

// Create main progress bar
const progressBar = blessed.progressbar({
    parent: screen,
    top: 3,
    left: 0,
    width: '100%',
    height: 3,
    border: 'line',
    style: {
        fg: 'blue',
        bg: 'default',
        border: {
            fg: 'cyan'
        },
        bar: {
            bg: 'blue'
        }
    },
    filled: 0
});

// Create log box
const logBox = blessed.log({
    parent: screen,
    top: 6,
    left: 0,
    width: '100%',
    height: '70%',
    border: 'line',
    scrollable: true,
    mouse: true,
    keys: true,
    vi: true,
    alwaysScroll: true,
    tags: true,
    scrollbar: {
        ch: ' ',
        track: {
            bg: 'cyan'
        },
        style: {
            inverse: true
        }
    },
    style: {
        border: {
            fg: 'cyan'
        }
    }
});

// Create active downloads box
const activeBox = blessed.box({
    parent: screen,
    bottom: 3,
    left: 0,
    width: '100%',
    height: 5,
    border: 'line',
    content: 'Active Downloads:',
    tags: true,
    style: {
        border: {
            fg: 'cyan'
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
    content: 'Ready to start...',
    style: {
        border: {
            fg: 'cyan'
        }
    }
});

// Load cache and errors
if (fs.existsSync(cacheFile)) {
    try {
        cache = fs.readJsonSync(cacheFile);
        log(chalk.green(`✓ Loaded cache with ${Object.keys(cache).length} entries`));
    } catch (error) {
        log(chalk.red(`Error loading cache: ${error}`));
        cache = {};
    }
}

if (fs.existsSync(errorsFile)) {
    try {
        errors = fs.readJsonSync(errorsFile);
        log(chalk.yellow(`⚠ Loaded error log with ${Object.keys(errors).length} entries`));
    } catch (error) {
        log(chalk.red(`Error loading error log: ${error}`));
        errors = {};
    }
}

// UI update functions
function updateStatus() {
    const progress = totalTracks > 0 ? (completedTracks / totalTracks) * 100 : 0;
    progressBar.setProgress(progress);
    
    const statusContent = [
        chalk.cyan(`Total: ${chalk.bold(totalTracks.toString())}`),
        chalk.green(`Completed: ${chalk.bold(completedTracks.toString())}`),
        chalk.red(`Errors: ${chalk.bold(errorTracks.toString())}`),
        chalk.yellow(`Remaining: ${chalk.bold((totalTracks - completedTracks - errorTracks).toString())}`)
    ].join(' | ');
    
    statusBox.setContent(statusContent);
    screen.render();
}

function updateActiveDownloads(activeDownloads: Map<string, TrackInfo>) {
    let content = chalk.cyan.bold('Active Downloads:\n');
    
    if (activeDownloads.size === 0) {
        content += '  No active downloads';
    } else {
        activeDownloads.forEach((info, url) => {
            const title = info.title || url;
            const status = info.status === 'downloading' ? 
                chalk.yellow('⬇️ Downloading') : 
                info.status === 'transcoding' ? 
                    chalk.blue('🔄 Transcoding') : 
                    chalk.green('✓ ' + info.status);
            
            const progress = info.progress ? ` ${info.progress.toFixed(1)}%` : '';
            const eta = info.eta ? ` ETA: ${info.eta}` : '';
            
            content += `  ${chalk.white(title.substring(0, 40))}${title.length > 40 ? '...' : ''} - ${status}${progress}${eta}\n`;
        });
    }
    
    activeBox.setContent(content);
    screen.render();
}

function log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    logBox.log(`${chalk.gray(`[${timestamp}]`)} ${message}`);
    screen.render();
}

function sanitizeFilename(filename: string): string {
    // More comprehensive sanitization for better file naming
    return filename
        .replace(/[\\/:"*?<>|]+/g, '_') // Replace invalid file characters
        .replace(/\s+/g, '_')           // Replace spaces with underscores
        .replace(/__+/g, '_')           // Replace multiple underscores with single
        .replace(/^_|_$/g, '')          // Remove leading/trailing underscores
        .toLowerCase()
        .substring(0, 100);             // Limit filename length
}

// Active downloads tracking
const activeDownloads = new Map<string, TrackInfo>();

async function downloadTrack(url: string): Promise<void> {
    // Skip if already downloaded successfully
    if (cache[url]?.downloaded) {
        log(chalk.gray(`Skipping already downloaded track: ${url}`));
        completedTracks++;
        updateStatus();
        return;
    }

    // Skip if too many retries
    if (cache[url]?.retries && cache[url].retries >= config.maxRetries) {
        log(chalk.yellow(`⚠ Skipping track with too many retries: ${url}`));
        errorTracks++;
        updateStatus();
        return;
    }

    try {
        // Add to active downloads
        activeDownloads.set(url, { 
            url, 
            title: url,
            status: 'pending'
        });
        updateActiveDownloads(activeDownloads);

        // Fetch metadata
        log(chalk.blue(`🔍 Fetching metadata for: ${url}`));
        try {
            const metadata = JSON.parse(execSync(`yt-dlp -j ${url}`, { encoding: 'utf-8' }));
            const title = metadata.title;
            const duration = metadata.duration;
            const sanitizedTitle = sanitizeFilename(title);
            const outputPath = path.join(downloadDirectory, `${sanitizedTitle}.mp4`);
            
            // Update active downloads with title
            activeDownloads.set(url, { 
                url, 
                title, 
                status: 'downloading' 
            });
            updateActiveDownloads(activeDownloads);

            // Download video
            log(chalk.blue(`⬇️ Downloading: ${chalk.bold(title)}`));
            execSync(`yt-dlp -i --no-overwrites -f "${fallbackFormat}" -o "${outputPath}" ${url}`, { 
                stdio: 'pipe' 
            });

            // Update status to transcoding
            activeDownloads.set(url, { 
                url, 
                title, 
                status: 'transcoding' 
            });
            updateActiveDownloads(activeDownloads);

            // Transcode for car multimedia compatibility
            log(chalk.magenta(`🔄 Transcoding: ${chalk.bold(title)}`));
            const tempOutput = path.join(downloadDirectory, `${sanitizedTitle}_temp.mp4`);
            
            const { codec, profile, level, resolution, maxRate, bufSize, audioCodec, audioBitrate } = config.videoFormat;
            
            execSync(
                `ffmpeg -y -i "${outputPath}" -c:v ${codec} -profile:v ${profile} -level ${level} ` +
                `-maxrate ${maxRate} -bufsize ${bufSize} -vf "scale=${resolution}" ` +
                `-c:a ${audioCodec} -b:a ${audioBitrate} "${tempOutput}"`, 
                { stdio: 'pipe' }
            );

            // Replace original with transcoded version
            fs.removeSync(outputPath);
            fs.renameSync(tempOutput, outputPath);

            // Update cache
            cache[url] = {
                downloaded: true,
                title: title,
                lastAttempt: new Date().toISOString()
            };
            fs.writeJsonSync(cacheFile, cache, { spaces: 2 });

            // Update counters and UI
            completedTracks++;
            updateStatus();
            log(chalk.green(`✓ Completed: ${chalk.bold(title)}`));
        } catch (innerError) {
            const innerErrorMsg = innerError instanceof Error ? innerError.message : String(innerError);
            log(chalk.red(`❌ Error processing ${url}: ${innerErrorMsg}`));
            
            // If the error is from execSync, log stdout/stderr
            if (innerError && (innerError as any).stdout) {
                log(chalk.yellow(`Command output: ${(innerError as any).stdout.toString()}`));
            }
            if (innerError && (innerError as any).stderr) {
                log(chalk.yellow(`Command error output: ${(innerError as any).stderr.toString()}`));
            }
            
            throw innerError; // Re-throw to be caught by outer catch
        }
        
        // Remove from active downloads
        activeDownloads.delete(url);
        updateActiveDownloads(activeDownloads);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(chalk.red(`❌ Error downloading ${url}: ${errorMessage}`));
        
        if (error instanceof Error && error.stack) {
            log(chalk.red(`Stack trace for ${url.substring(0, 30)}...: ${error.stack.split('\n')[0]}`));
        }
        
        // Update error cache
        cache[url] = {
            downloaded: false,
            error: errorMessage,
            retries: (cache[url]?.retries || 0) + 1,
            lastAttempt: new Date().toISOString()
        };
        fs.writeJsonSync(cacheFile, cache, { spaces: 2 });
        
        // Update error log
        errors[url] = {
            ...cache[url],
            timestamp: new Date().toISOString()
        };
        fs.writeJsonSync(errorsFile, errors, { spaces: 2 });
        
        // Update counters and UI
        errorTracks++;
        updateStatus();
        
        // Remove from active downloads
        activeDownloads.delete(url);
        updateActiveDownloads(activeDownloads);
    }
}

async function getTracksFromPlaylist(url: string): Promise<string[]> {
    try {
        log(chalk.blue(`📋 Fetching playlist: ${url}`));
        const output = execSync(`yt-dlp --flat-playlist -J ${url}`, { encoding: 'utf-8' });
        
        try {
            const playlistData = JSON.parse(output);
            if (!playlistData.entries || !Array.isArray(playlistData.entries)) {
                log(chalk.yellow(`⚠ Playlist data doesn't contain entries array: ${url}`));
                log(chalk.yellow(`Output: ${output.substring(0, 200)}...`));
                return [];
            }
            
            const tracks = playlistData.entries.map((entry: any) => `https://youtube.com/watch?v=${entry.id}`);
            log(chalk.green(`✓ Found ${tracks.length} tracks in playlist`));
            return tracks;
        } catch (parseError) {
            log(chalk.red(`❌ Failed to parse playlist JSON: ${parseError}`));
            log(chalk.yellow(`Raw output (first 200 chars): ${output.substring(0, 200)}...`));
            throw new Error(`JSON parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(chalk.red(`❌ Failed to fetch playlist: ${url}`));
        log(chalk.red(`Error: ${errorMessage}`));
        
        // If the error is from execSync, it might have stdout/stderr
        if (error && (error as any).stdout) {
            log(chalk.yellow(`Command output: ${(error as any).stdout.toString()}`));
        }
        if (error && (error as any).stderr) {
            log(chalk.yellow(`Command error output: ${(error as any).stderr.toString()}`));
        }
        
        return [];
    }
}

// Check if required tools are installed
function checkRequirements(): boolean {
    try {
        log(chalk.blue('🔍 Checking requirements...'));
        
        // Check yt-dlp
        try {
            const ytdlpVersion = execSync('yt-dlp --version', { stdio: 'pipe', encoding: 'utf8' }).trim();
            log(chalk.green(`✓ yt-dlp is installed (version: ${ytdlpVersion})`));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log(chalk.red(`❌ yt-dlp check failed: ${errorMessage}`));
            log(chalk.yellow('⚠ Please install yt-dlp: https://github.com/yt-dlp/yt-dlp#installation'));
            return false;
        }
        
        // Check ffmpeg
        try {
            const ffmpegVersion = execSync('ffmpeg -version', { stdio: 'pipe', encoding: 'utf8' }).split('\n')[0];
            log(chalk.green(`✓ ffmpeg is installed (${ffmpegVersion})`));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log(chalk.red(`❌ ffmpeg check failed: ${errorMessage}`));
            log(chalk.yellow('⚠ Please install ffmpeg: https://ffmpeg.org/download.html'));
            return false;
        }
        
        return true;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(chalk.red(`❌ Requirements check failed with unexpected error: ${errorMessage}`));
        if (error instanceof Error && error.stack) {
            log(chalk.red(`Stack trace: ${error.stack}`));
        }
        log(chalk.yellow('⚠ Please ensure yt-dlp and ffmpeg are properly installed and accessible in your PATH'));
        return false;
    }
}

// Display help information
function displayHelp() {
    const helpText = `
${chalk.cyan.bold('YouTube Music Downloader for Car Multimedia')}

${chalk.yellow('Controls:')}
  ${chalk.green('q or Ctrl+C')} - Quit the application
  ${chalk.green('Arrow keys')} - Navigate the log
  
${chalk.yellow('Features:')}
  - Downloads videos and playlists from YouTube
  - Optimizes videos for car multimedia systems
  - Parallel processing for faster downloads
  - Smart caching to resume interrupted downloads
  - Detailed error logging and recovery
  
${chalk.yellow('Video Format:')}
  - H.264 baseline profile (level 3.0)
  - 720p resolution with 2Mbps bitrate limit
  - AAC audio at 192kbps for high quality
  
${chalk.yellow('Files:')}
  - Downloaded videos: ${downloadDirectory}
  - Cache: ${cacheFile}
  - Error log: ${errorsFile}
`;
    
    log(helpText);
}

async function main() {
    try {
        // Display welcome message
        log(chalk.cyan.bold('🎵 YouTube Music Downloader for Car Multimedia 🚗'));
        log(chalk.gray('Press q or Ctrl+C to exit at any time'));
        
        // Check requirements
        if (!checkRequirements()) {
            log(chalk.red('❌ Exiting due to missing requirements'));
            screen.key(['q', 'C-c'], () => process.exit(1));
            return;
        }
        
        // Create download directory if it doesn't exist
        try {
            fs.ensureDirSync(downloadDirectory);
            log(chalk.green(`✓ Download directory ready: ${downloadDirectory}`));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log(chalk.red(`❌ Failed to create download directory: ${errorMessage}`));
            log(chalk.red(`Path: ${downloadDirectory}`));
            process.exit(1);
        }

        // Display help
        displayHelp();
        
        // Get all tracks
        log(chalk.blue('📋 Gathering tracks from playlists and videos...'));
        const allTracks: string[] = [];
        
        // Process playlists
        for (const playlistUrl of config.playlistUrls) {
            try {
                const trackUrls = await getTracksFromPlaylist(playlistUrl);
                allTracks.push(...trackUrls);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                log(chalk.red(`❌ Failed to process playlist ${playlistUrl}: ${errorMessage}`));
                // Continue with other playlists instead of failing completely
            }
        }
        
        // Add individual videos
        allTracks.push(...config.videoUrls);
        totalTracks = allTracks.length;
        
        if (totalTracks === 0) {
            log(chalk.red('❌ No tracks found to download. Check your playlist and video URLs.'));
            process.exit(1);
        }
        
        log(chalk.green(`✓ Found ${totalTracks} total tracks to process`));

        // Initialize progress
        updateStatus();

        // Set up parallel processing
        log(chalk.blue(`🚀 Starting download with ${config.concurrency} parallel processes`));
        
        // Use p-limit for parallel processing
        try {
            const pLimit = require('p-limit');
            const limit = pLimit(config.concurrency);
            
            const promises = allTracks.map(url => limit(() => downloadTrack(url)));

            // Wait for all downloads to complete
            await Promise.all(promises);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log(chalk.red(`❌ Error during parallel processing: ${errorMessage}`));
            if (error instanceof Error && error.stack) {
                log(chalk.red(`Stack trace: ${error.stack}`));
            }
            throw error; // Re-throw to be caught by the outer catch
        }

        // Final status
        log(chalk.green.bold('\n✅ Download complete!'));
        log(chalk.cyan(`📊 Summary:`));
        log(chalk.white(`  Total tracks: ${totalTracks}`));
        log(chalk.green(`  Completed: ${completedTracks}`));
        log(chalk.red(`  Errors: ${errorTracks}`));
        log(chalk.yellow(`  Remaining: ${totalTracks - completedTracks - errorTracks}`));

        if (errorTracks > 0) {
            log(chalk.yellow(`⚠ Some tracks had errors. Check ${errorsFile} for details.`));
        }

        // Keep the screen open until user presses 'q'
        statusBox.setContent(chalk.green.bold('✅ Download complete! Press q to exit'));
        screen.render();
        screen.key(['q', 'C-c'], () => process.exit(0));
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(chalk.red(`❌ Fatal error in main function: ${errorMessage}`));
        if (error instanceof Error && error.stack) {
            log(chalk.red(`Stack trace: ${error.stack}`));
        }
        
        // Save current state
        try {
            fs.writeJsonSync(cacheFile, cache, { spaces: 2 });
            fs.writeJsonSync(errorsFile, errors, { spaces: 2 });
            log(chalk.yellow('✓ Saved current progress to cache files'));
        } catch (saveError) {
            log(chalk.red(`❌ Failed to save progress: ${saveError}`));
        }
        
        process.exit(1);
    }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    log(chalk.red(`❌ FATAL UNCAUGHT EXCEPTION: ${error.message}`));
    log(chalk.red(`Stack trace: ${error.stack || 'No stack trace available'}`));
    log(chalk.yellow('Process will exit after saving current state'));
    
    // Save current state
    try {
        fs.writeJsonSync(cacheFile, cache, { spaces: 2 });
        fs.writeJsonSync(errorsFile, errors, { spaces: 2 });
        log(chalk.yellow('✓ Saved current progress to cache files'));
    } catch (saveError) {
        log(chalk.red(`❌ Failed to save progress during crash: ${saveError}`));
    }
    
    // Exit after a delay to allow logs to be written
    setTimeout(() => {
        log(chalk.red('Exiting due to fatal error'));
        process.exit(1);
    }, 1000);
});

// Also add a handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    log(chalk.red(`❌ UNHANDLED PROMISE REJECTION: ${reason}`));
    if (reason instanceof Error) {
        log(chalk.red(`Stack trace: ${reason.stack || 'No stack trace available'}`));
    }
    log(chalk.yellow('This is a bug in the application that should be fixed'));
    
    // We don't exit here, but log it for debugging
});

// Start the application
main().catch(error => {
    log(chalk.red(`❌ Fatal error: ${error}`));
    process.exit(1);
});
