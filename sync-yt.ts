import { spawn, SpawnOptions } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { Readable } from 'stream';
import blessed from 'blessed';
import chalk from 'chalk';
// Using require for p-limit since it's a CommonJS module in our setup
const pLimit = require('p-limit');

// Helper function to convert time format (HH:MM:SS.ms) to seconds
function timeToSeconds(time: string): number {
    const parts = time.split(':');
    if (parts.length === 3) {
        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        const seconds = parseFloat(parts[2]);
        return hours * 3600 + minutes * 60 + seconds;
    }
    return 0;
}

// Helper function to format seconds to MM:SS
function formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// For throttling UI updates
let throttle: Function;
try {
    throttle = require('lodash.throttle');
} catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error loading lodash.throttle: ', errorMessage);
    console.error('Please install it using: yarn add lodash.throttle');
    console.error('Falling back to a simple throttle implementation');
    
    // Simple throttle implementation as fallback
    throttle = function(func: Function, wait: number) {
        let lastCall = 0;
        return function(...args: any[]) {
            const now = Date.now();
            if (now - lastCall >= wait) {
                lastCall = now;
                return func(...args);
            }
        };
    };
}

// UI refresh control constants
const RENDER_THROTTLE_MS = 100; // Minimum time between renders
const LOG_BUFFER_SIZE = 1000; // Maximum number of log lines to keep
const logBuffer: string[] = [];
let uiNeedsUpdate = false;
let lastScreenRender = Date.now();


// Debug flag for console logging
const DEBUG = false;

// Throttled log function to prevent UI freezing with too many updates
const log = (function() {
    // The actual logging function
    function logMessage(message: string) {
        const timestamp = new Date().toLocaleTimeString();
        const formattedMessage = `${chalk.gray(`[${timestamp}]`)} ${message}`;
        
        // Add to buffer for memory management
        logBuffer.push(formattedMessage);
        if (logBuffer.length > LOG_BUFFER_SIZE) {
            logBuffer.shift(); // Remove oldest log entry
        }
        
        try {
            // Log to UI - use pushLine instead of log to ensure proper containment
            logBox.pushLine(formattedMessage);
            // Only log to console if debugging is enabled
            if (DEBUG) {
                console.log(`${timestamp} ${message}`);
            }
            
            // Request a render, but don't force it immediately
            uiNeedsUpdate = true;
        } catch (error) {
            // Fallback to console if UI fails
            console.error(`${timestamp} ${message}`);
            console.error('UI error:', error);
        }
    }
    
    // Return the throttled version
    return throttle(logMessage, RENDER_THROTTLE_MS / 2);
})();

// Configuration
const config = {
    playlistUrls: [
        'https://youtube.com/playlist?list=PL6YVnWd7IiQVHepsVJGTO7hodBqMeRg2t', // Topz
        'https://www.youtube.com/playlist?list=OLAK5uy_k_jFyltFvjyyYWHUugmYak6qFBY5KEf98' // Above and Beyond Acoustic 1
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

// Directories for downloaded music and temporary files
const downloadDirectory = path.join(__dirname, "/Downloaded");
const tempDirectory = path.join(__dirname, "/Temp");
const stateFile = path.join(__dirname, "/sync_state.json");
// More flexible format selection to handle signature extraction issues
const fallbackFormat = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
// Additional yt-dlp parameters to help with signature extraction issues
const ytdlpExtraParams = [
    '--no-check-certificates',  // Skip HTTPS certificate validation
    '--force-ipv4',  // Force IPv4 to avoid some CDN issues
    '--geo-bypass',  // Bypass geo-restrictions
    '--ignore-errors',  // Continue on download errors
    '--extractor-retries', '10',  // Increase extraction retries
    '--skip-unavailable-fragments',  // Skip unavailable fragments
    '--no-check-formats'  // Don't check formats before downloading
];

interface TrackState {
    downloaded: boolean;
    title?: string;
    error?: string;
    retries?: number;
    lastAttempt?: string;
    timestamp?: string;
}

interface AppState {
    tracks: {
        [url: string]: TrackState;
    };
    stats: {
        totalTracks: number;
        completedTracks: number;
        errorTracks: number;
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
    speed?: string;
    process?: ReturnType<typeof spawn>;
}

// Track all child processes
const activeProcesses: Set<ReturnType<typeof spawn>> = new Set();


let appState: AppState = {
    tracks: {},
    stats: {
        totalTracks: 0,
        completedTracks: 0,
        errorTracks: 0
    }
};

// Check terminal size
function checkTerminalSize() {
    const minRows = 24;
    const minCols = 80;
    
    if (process.stdout.rows < minRows || process.stdout.columns < minCols) {
        console.warn(`\n⚠️  WARNING: Terminal size too small (${process.stdout.columns}x${process.stdout.rows})`);
        console.warn(`   Recommended minimum: ${minCols}x${minRows}`);
        console.warn(`   The UI may not display correctly.\n`);
        return false;
    }
    return true;
}

// Initialize blessed screen
const screen = blessed.screen({
    smartCSR: true,
    title: 'YouTube Music Downloader for Car Multimedia',
    debug: false, // Set to false for production
    fullUnicode: true,
    autoPadding: true,
    forceUnicode: true,
    fastCSR: true,
    resizeTimeout: 300
});

// Initial render to ensure screen is working
try {
    checkTerminalSize();
    screen.render();
    console.log('Initial screen render successful');
} catch (error) {
    console.error('Error during initial screen render:', error);
}

// Handle terminal resize
screen.on('resize', () => {
    checkTerminalSize();
    try {
        // Reflow the log box content on resize
        logBox.setContent('');
        for (const line of logBuffer.slice(-50)) { // Show last 50 lines on resize
            logBox.pushLine(line);
        }
        screen.render();
    } catch (error) {
        console.error('Error rendering after resize:', error);
    }
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

// Create active downloads box
const activeBox = blessed.box({
    parent: screen,
    top: 6,
    left: 0,
    width: '100%',
    height: 10, // Increase height to show more active downloads
    border: 'line',
    content: 'Active Downloads:',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
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

// Create status box
const statusBox = blessed.box({
    parent: screen,
    top: 16, // Adjust top position based on new activeBox height
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

// Create log box
const logBox = blessed.log({
    parent: screen,
    top: 19, // Adjust top position based on new statusBox position
    bottom: 0,
    left: 0,
    width: '100%',
    height: 'shrink', // Use shrink to fit between top and bottom
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
    },
    // Limit the number of lines to prevent memory issues
    scrollback: LOG_BUFFER_SIZE
});



// Load state from file
if (fs.existsSync(stateFile)) {
    try {
        appState = fs.readJsonSync(stateFile);
        log(chalk.green(`✓ Loaded state with ${Object.keys(appState.tracks).length} track entries`));
    } catch (error) {
        log(chalk.red(`Error loading state file: ${error}`));
        appState = {
            tracks: {},
            stats: {
                totalTracks: 0,
                completedTracks: 0,
                errorTracks: 0
            }
        };
    }
}

// Safe render function
function safeRender() {
    try {
        // Throttle renders to avoid overwhelming the terminal
        const now = Date.now();
        if (now - lastScreenRender >= RENDER_THROTTLE_MS) {
            screen.render();
            lastScreenRender = now;
            uiNeedsUpdate = false;
        } else {
            // If we can't render now, mark for update later
            uiNeedsUpdate = true;
        }
    } catch (error) {
        console.error('Error rendering screen:', error);
    }
}

// Set up periodic render for throttled updates
setInterval(() => {
    if (uiNeedsUpdate) {
        try {
            screen.render();
            lastScreenRender = Date.now();
            uiNeedsUpdate = false;
        } catch (error) {
            console.error('Error in periodic render:', error);
        }
    }
}, RENDER_THROTTLE_MS);


// UI update functions
function updateStatus() {
    const { totalTracks, completedTracks, errorTracks } = appState.stats;
    const progress = totalTracks > 0 ? (completedTracks / totalTracks) * 100 : 0;
    progressBar.setProgress(progress);
    
    const statusContent = [
        chalk.cyan(`Total: ${chalk.bold(totalTracks.toString())}`),
        chalk.green(`Completed: ${chalk.bold(completedTracks.toString())}`),
        chalk.red(`Errors: ${chalk.bold(errorTracks.toString())}`),
        chalk.yellow(`Remaining: ${chalk.bold((totalTracks - completedTracks - errorTracks).toString())}`)
    ].join(' | ');
    
    statusBox.setContent(statusContent);
    safeRender();
}

// Throttled version of updateActiveDownloads to prevent too many renders
const updateActiveDownloads = throttle((activeDownloads: Map<string, TrackInfo>) => {
    // Clear the box first to prevent artifacts
    activeBox.setContent('');
    
    // Add the header
    activeBox.pushLine(chalk.cyan.bold('Active Downloads:'));
    
    if (activeDownloads.size === 0) {
        activeBox.pushLine('  No active downloads');
    } else {
        // Define fixed widths for each column
        const titleWidth = 160;
        const statusWidth = 15;
        const progressWidth = 10;
        const sizeWidth = 15;
        const speedWidth = 15;
        const etaWidth = 12;
        
        activeDownloads.forEach((info, url) => {
            const title = info.title || url;
            const displayTitle = title.length > titleWidth 
                ? title.substring(0, titleWidth - 3) + '...' 
                : title.padEnd(titleWidth);
                
            // Format status with consistent width
            let statusText = '';
            if (info.status === 'downloading') {
                statusText = chalk.yellow('⬇️ Downloading');
            } else if (info.status === 'transcoding') {
                statusText = chalk.blue('🔄 Transcoding');
            } else {
                statusText = chalk.green('✓ ' + info.status);
            }
            const status = statusText.padEnd(statusWidth);
            
            // Format other fields with consistent width
            const progress = info.progress 
                ? `${info.progress.toFixed(1)}%`.padEnd(progressWidth) 
                : ''.padEnd(progressWidth);
                
            const size = info.size 
                ? info.size.padEnd(sizeWidth) 
                : ''.padEnd(sizeWidth);
                
            const speed = info.speed 
                ? info.speed.padEnd(speedWidth) 
                : ''.padEnd(speedWidth);
                
            const eta = info.eta 
                ? `ETA: ${info.eta}`.padEnd(etaWidth) 
                : ''.padEnd(etaWidth);
            
            // Combine all parts with proper spacing
            const line = `  ${chalk.white(displayTitle)} ${status} ${progress} ${size} ${speed} ${eta}`;
            activeBox.pushLine(line);
        });
    }
    
    safeRender();
}, RENDER_THROTTLE_MS);


function sanitizeFilename(filename: string): string {
    // More comprehensive sanitization for better file naming
    return filename
        .replace(/[\\/:"*?<>|]+/g, '-') // Replace invalid file characters with hyphens
        // Keep spaces instead of replacing with underscores
        .replace(/--+/g, '-')           // Replace multiple hyphens with single
        .replace(/^-|-$/g, '')          // Remove leading/trailing hyphens
        .substring(0, 100);             // Limit filename length
}

// Execute a command asynchronously and return its output
async function execAsync(command: string, args: string[], options: SpawnOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        const process = spawn(command, args, { ...options, shell: false });
        activeProcesses.add(process);
        
        let stdout = '';
        let stderr = '';
        
        if (process.stdout) {
            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });
        }
        
        if (process.stderr) {
            process.stderr.on('data', (data) => {
                stderr += data.toString();
            });
        }
        
        process.on('close', (code) => {
            activeProcesses.delete(process);
            if (code === 0) {
                resolve(stdout);
            } else {
                const error = new Error(`Command failed with code ${code}: ${command} ${args.join(' ')}`);
                (error as any).stdout = stdout;
                (error as any).stderr = stderr;
                reject(error);
            }
        });
        
        process.on('error', (error) => {
            activeProcesses.delete(process);
            reject(error);
        });
    });
}

// Parse JSON safely
function safeJsonParse(text: string): any {
    try {
        return JSON.parse(text);
    } catch (error) {
        log(chalk.red(`JSON parse error: ${error instanceof Error ? error.message : String(error)}`));
        log(chalk.yellow(`Raw text (first 200 chars): ${text.substring(0, 200)}...`));
        throw error;
    }
}

// Helper function to resolve the actual downloaded file
function resolveDownloadedFile(baseOutputPath: string): string {
    // Check for common extensions that yt-dlp might use
    const possibleExtensions = ['.mp4', '.webm', '.mkv', '.m4a', '.mp3'];
    
    for (const ext of possibleExtensions) {
        const filePath = baseOutputPath + ext;
        if (fs.existsSync(filePath)) {
            log(chalk.blue(`✓ Found downloaded file with extension: ${ext}`));
            return filePath;
        }
    }
    
    // If no file is found, log a warning and return the default .webm path
    // This maintains backward compatibility with the original code
    log(chalk.yellow(`⚠ Could not find downloaded file for ${baseOutputPath}, falling back to .webm`));
    return baseOutputPath + '.webm';
}

// Helper function to build FFmpeg arguments
function buildFfmpegArgs(inputPath: string, outputPath: string): string[] {
    const { codec, profile, level, resolution, maxRate, bufSize, audioCodec, audioBitrate } = config.videoFormat;
    
    return [
        '-y',
        '-i', inputPath,
        '-c:v', codec,
        '-profile:v', profile,
        '-level', level,
        '-maxrate', maxRate,
        '-bufsize', bufSize,
        '-vf', `scale=${resolution}`,
        '-c:a', audioCodec,
        '-b:a', audioBitrate,
        outputPath
    ];
}

// Active downloads tracking
const activeDownloads = new Map<string, TrackInfo>();

// Fetch metadata for a track
async function fetchMetadata(url: string): Promise<{ title: string; duration: number; sanitizedTitle: string }> {
    log(chalk.blue(`🔍 Fetching metadata for: ${url}`));
    
    // Use enhanced parameters for metadata fetching
    const metadataOutput = await execAsync('yt-dlp', [
        '--cookies-from-browser', 'vivaldi:Default', 
        '-j', 
        ...ytdlpExtraParams,
        url
    ]);
    
    const metadata = safeJsonParse(metadataOutput);
    const title = metadata.title;
    const duration = metadata.duration || 0; // Default to 0 if duration is not available
    const sanitizedTitle = sanitizeFilename(title);
    
    return { title, duration, sanitizedTitle };
}

// Download video using yt-dlp
async function downloadVideo(url: string, outputPath: string, trackInfo: TrackInfo): Promise<void> {
    log(chalk.blue(`⬇️ Downloading: ${chalk.bold(trackInfo.title)}`));
    
    // Update status to downloading
    trackInfo.status = 'downloading';
    activeDownloads.set(url, trackInfo);
    updateActiveDownloads(activeDownloads);
    
    // Build download command with extra parameters to handle signature issues
    const downloadArgs = [
        '-i', 
        '--no-overwrites', 
        '--cookies-from-browser', 'vivaldi:Default',
        '-f', fallbackFormat, 
        '--force-overwrites',  // Force overwrite if needed
        '--no-playlist',  // Ensure we only download the single video
        '--downloader', 'aria2c',  // Try using aria2c downloader for better reliability
        '--downloader-args', 'aria2c:"-x 16 -s 16 -k 1M"',  // Optimize aria2c parameters
        ...ytdlpExtraParams,  // Add our extra parameters for handling signature issues
        '-o', outputPath, 
        url
    ];
    
    log(chalk.gray(`Running yt-dlp with enhanced parameters to handle signature issues`));
    const downloadProcess = spawn('yt-dlp', downloadArgs, { stdio: 'pipe' });
    
    activeProcesses.add(downloadProcess);
    trackInfo.process = downloadProcess;
    activeDownloads.set(url, trackInfo);
    
    // Wait for download to complete
    await new Promise<void>((resolve, reject) => {
        let downloadOutput = '';
        
        if (downloadProcess.stdout) {
            downloadProcess.stdout.on('data', (data) => {
                downloadOutput += data.toString();
                // Could parse progress here if needed
            });
        }
        
        if (downloadProcess.stderr) {
            downloadProcess.stderr.on('data', (data) => {
                const errorText = data.toString();
                // Try to parse progress information from yt-dlp
                // Example: [download]   4.7% of ~ 153.81MiB at    2.19MiB/s ETA 01:12 (frag 41/926)
                const progressMatch = errorText.match(/\[download\]\s+(\d+\.\d+)%\s+of\s+~?\s*(\d+\.\d+)(\w+)\s+at\s+(\d+\.\d+)(\w+)\/s\s+ETA\s+(\d+:\d+)/);
                if (progressMatch) {
                    const [, percent, size, sizeUnit, speed, speedUnit, eta] = progressMatch;
                    trackInfo.progress = parseFloat(percent);
                    trackInfo.size = `${size}${sizeUnit}`;
                    trackInfo.speed = `${speed}${speedUnit}/s`;
                    trackInfo.eta = eta;
                    activeDownloads.set(url, trackInfo);
                    updateActiveDownloads(activeDownloads);
                }
                log(chalk.yellow(`Download warning: ${errorText.trim()}`));
            });
        }
        
        downloadProcess.on('close', (code) => {
            activeProcesses.delete(downloadProcess);
            if (code === 0) {
                resolve();
            } else {
                const error = new Error(`Download failed with code ${code}`);
                (error as any).stdout = downloadOutput;
                reject(error);
            }
        });
        
        downloadProcess.on('error', (error) => {
            activeProcesses.delete(downloadProcess);
            reject(error);
        });
    });
}

// Transcode video using FFmpeg
async function transcodeVideo(inputPath: string, outputPath: string, trackInfo: TrackInfo): Promise<void> {
    log(chalk.magenta(`🔄 Transcoding: ${chalk.bold(trackInfo.title)}`));
    
    // Update status to transcoding
    trackInfo.status = 'transcoding';
    activeDownloads.set(trackInfo.url, trackInfo);
    updateActiveDownloads(activeDownloads);
    
    // Build FFmpeg arguments
    const ffmpegArgs = buildFfmpegArgs(inputPath, outputPath);
    
    const transcodeProcess = spawn('ffmpeg', ffmpegArgs, { stdio: 'pipe' });
    activeProcesses.add(transcodeProcess);
    trackInfo.process = transcodeProcess;
    activeDownloads.set(trackInfo.url, trackInfo);
    
    // Wait for transcoding to complete
    await new Promise<void>((resolve, reject) => {
        let transcodeOutput = '';
        
        if (transcodeProcess.stdout) {
            transcodeProcess.stdout.on('data', (data) => {
                transcodeOutput += data.toString();
            });
        }
        
        if (transcodeProcess.stderr) {
            transcodeProcess.stderr.on('data', (data) => {
                const text = data.toString();
                // FFmpeg outputs progress to stderr
                transcodeOutput += text;
                
                // Try to parse FFmpeg progress information
                const timeMatch = text.match(/time=(\d+:\d+:\d+\.\d+)/);
                if (timeMatch) {
                    const time = timeMatch[1];
                    
                    // Look for duration in the accumulated output
                    const durationMatch = transcodeOutput.match(/Duration: (\d+:\d+:\d+\.\d+)/);
                    
                    if (durationMatch) {
                        const duration = durationMatch[1];
                        
                        // Convert time and duration to seconds
                        const timeSeconds = timeToSeconds(time);
                        const durationSeconds = timeToSeconds(duration);
                        
                        if (durationSeconds > 0) {
                            const percent = (timeSeconds / durationSeconds) * 100;
                            trackInfo.progress = percent;
                            
                            // Calculate ETA
                            const remainingSeconds = durationSeconds - timeSeconds;
                            if (remainingSeconds > 0) {
                                trackInfo.eta = formatTime(remainingSeconds);
                            }
                            
                            activeDownloads.set(trackInfo.url, trackInfo);
                            updateActiveDownloads(activeDownloads);
                        }
                    }
                }
            });
        }
        
        transcodeProcess.on('close', (code) => {
            activeProcesses.delete(transcodeProcess);
            if (code === 0) {
                resolve();
            } else {
                const error = new Error(`Transcoding failed with code ${code}`);
                (error as any).stderr = transcodeOutput;
                log(chalk.red(`FFmpeg failed stderr: ${(error as any).stderr?.slice(-500)}`));
                reject(error);
            }
        });
        
        transcodeProcess.on('error', (error) => {
            activeProcesses.delete(transcodeProcess);
            reject(error);
        });
    });
}

// Finalize track by replacing original with transcoded version and updating state
async function finalizeTrack(url: string, title: string, outputPath: string, tempOutput: string): Promise<void> {
    log(chalk.green(`✓ Finalizing: ${chalk.bold(title)}`));
    
    // Replace original with transcoded version
    fs.removeSync(outputPath);
    fs.renameSync(tempOutput, outputPath);
    
    // Update state
    appState.tracks[url] = {
        downloaded: true,
        title: title,
        lastAttempt: new Date().toISOString(),
        timestamp: new Date().toISOString()
    };
    fs.writeJsonSync(stateFile, appState, { spaces: 2 });
    
    // Update counters and UI
    appState.stats.completedTracks++;
    updateStatus();
    log(chalk.green(`✓ Completed: ${chalk.bold(title)}`));
}

// Handle track download errors
function handleTrackError(url: string, error: any, trackInfo?: TrackInfo): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(chalk.red(`❌ Error processing ${url}: ${errorMessage}`));
    
    // Log additional error details if available
    if (error && (error as any).stdout) {
        log(chalk.yellow(`Command output: ${(error as any).stdout.toString()}`));
    }
    if (error && (error as any).stderr) {
        log(chalk.yellow(`Command error output: ${(error as any).stderr.toString()}`));
    }
    
    // Log stack trace for debugging
    if (error instanceof Error && error.stack) {
        log(chalk.red(`Stack trace for ${url.substring(0, 30)}...: ${error.stack.split('\n')[0]}`));
    }
    
    // Update state with error
    appState.tracks[url] = {
        downloaded: false,
        title: trackInfo?.title,
        error: errorMessage,
        retries: (appState.tracks[url]?.retries || 0) + 1,
        lastAttempt: new Date().toISOString(),
        timestamp: new Date().toISOString()
    };
    fs.writeJsonSync(stateFile, appState, { spaces: 2 });
    
    // Update counters and UI
    appState.stats.errorTracks++;
    updateStatus();
    
    // Remove from active downloads
    if (trackInfo) {
        activeDownloads.delete(url);
        updateActiveDownloads(activeDownloads);
    }
}

async function downloadTrack(url: string): Promise<void> {
    // Check if already downloaded successfully
    if (appState.tracks[url]?.downloaded) {
        // Get the title and check if the file exists
        const title = appState.tracks[url].title;
        if (title) {
            const sanitizedTitle = sanitizeFilename(title);
            const expectedFilePath = path.join(downloadDirectory, `${sanitizedTitle}.mp4`);
            
            if (fs.existsSync(expectedFilePath)) {
                log(chalk.gray(`Skipping already downloaded track: ${title}`));
                appState.stats.completedTracks++;
                updateStatus();
                return;
            } else {
                // File doesn't exist, reset the downloaded flag
                log(chalk.yellow(`⚠ Track marked as downloaded but file not found: ${title}`));
                log(chalk.blue(`🔄 Resetting download state for: ${title}`));
                appState.tracks[url].downloaded = false;
                // Don't increment error count as we're going to retry
            }
        } else {
            // No title in state, reset the downloaded flag
            log(chalk.yellow(`⚠ Track marked as downloaded but missing title information`));
            appState.tracks[url].downloaded = false;
        }
    }

    // Skip if too many retries
    if (appState.tracks[url]?.retries && appState.tracks[url].retries >= config.maxRetries) {
        log(chalk.yellow(`⚠ Skipping track with too many retries: ${url}`));
        appState.stats.errorTracks++;
        updateStatus();
        return;
    }

    // Track info for this download
    let trackInfo: TrackInfo = { 
        url, 
        title: url,
        status: 'pending'
    };
    
    try {
        // Add to active downloads
        activeDownloads.set(url, trackInfo);
        updateActiveDownloads(activeDownloads);

        // Fetch metadata using the extracted function
        const { title, duration, sanitizedTitle } = await fetchMetadata(url);
        
        // Final output path in the download directory
        const finalOutputPath = path.join(downloadDirectory, `${sanitizedTitle}.mp4`);
        
        // Temporary paths in the temp directory
        const tempDownloadPath = path.join(tempDirectory, `${sanitizedTitle}_download`);
        const tempTranscodePath = path.join(tempDirectory, `${sanitizedTitle}_transcode.mp4`);
            
        // Update trackInfo with title
        trackInfo.title = title;
        activeDownloads.set(url, trackInfo);
        updateActiveDownloads(activeDownloads);

        // Download video to temp directory
        await downloadVideo(url, tempDownloadPath, trackInfo);

        // Resolve the actual downloaded file
        const inputPath = resolveDownloadedFile(tempDownloadPath);
        
        // Transcode video to temp directory
        await transcodeVideo(inputPath, tempTranscodePath, trackInfo);

        // Move the final transcoded file to the download directory
        await finalizeTrack(url, title, finalOutputPath, tempTranscodePath);
        
        // Clean up any temporary files
        try {
            if (fs.existsSync(inputPath)) {
                fs.removeSync(inputPath);
                log(chalk.gray(`🧹 Cleaned up temporary download file: ${path.basename(inputPath)}`));
            }
            // Check for other possible temp files with different extensions
            const tempFilePattern = path.join(tempDirectory, `${sanitizedTitle}_download.*`);
            const tempFiles = fs.readdirSync(tempDirectory)
                .filter(file => file.startsWith(`${sanitizedTitle}_download`));
            
            for (const file of tempFiles) {
                fs.removeSync(path.join(tempDirectory, file));
                log(chalk.gray(`🧹 Cleaned up temporary file: ${file}`));
            }
        } catch (cleanupError) {
            // Just log cleanup errors, don't fail the download
            log(chalk.yellow(`⚠ Error during cleanup: ${cleanupError}`));
        }
        
        // Remove from active downloads
        activeDownloads.delete(url);
        updateActiveDownloads(activeDownloads);
    } catch (error) {
        // Handle error using the extracted function
        handleTrackError(url, error, trackInfo);
    }
}

async function getTracksFromPlaylist(url: string): Promise<string[]> {
    try {
        log(chalk.blue(`📋 Fetching playlist: ${url}`));
        const output = await execAsync('yt-dlp', [
            '--cookies-from-browser', 'vivaldi:Default', 
            '--flat-playlist', 
            '-J', 
            ...ytdlpExtraParams,
            url
        ]);
        
        try {
            const playlistData = safeJsonParse(output);
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
        
        // If the error has stdout/stderr, log it
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
async function checkRequirements(): Promise<boolean> {
    try {
        log(chalk.blue('🔍 Checking requirements...'));
        
        // Check yt-dlp
        try {
            const ytdlpVersion = await execAsync('yt-dlp', ['--version']);
            log(chalk.green(`✓ yt-dlp is installed (version: ${ytdlpVersion.trim()})`));
            
            // Update yt-dlp to latest version to handle signature extraction issues
            log(chalk.blue('🔄 Updating yt-dlp to latest version...'));
            try {
                const updateOutput = await execAsync('yt-dlp', ['--update-to', 'latest']);
                log(chalk.green(`✓ yt-dlp update: ${updateOutput.trim()}`));
                
                // Also try to update the youtube-dl extractor
                log(chalk.blue('🔄 Updating extractors...'));
                try {
                    const extractorOutput = await execAsync('yt-dlp', ['--update-extractors']);
                    log(chalk.green(`✓ Extractors update: ${extractorOutput.trim()}`));
                } catch (extractorError) {
                    log(chalk.yellow(`⚠ Could not update extractors: ${extractorError}`));
                }
            } catch (updateError) {
                log(chalk.yellow(`⚠ Could not auto-update yt-dlp: ${updateError}`));
                log(chalk.yellow('This is not critical, but using the latest version is recommended'));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log(chalk.red(`❌ yt-dlp check failed: ${errorMessage}`));
            log(chalk.yellow('⚠ Please install yt-dlp: https://github.com/yt-dlp/yt-dlp#installation'));
            return false;
        }
        
        // Check ffmpeg
        try {
            const ffmpegVersion = (await execAsync('ffmpeg', ['-version'])).split('\n')[0];
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
  - State file: ${stateFile}
`;
    
    log(helpText);
}

async function main() {
    try {
        console.log('Application starting...');  // Direct console output for debugging
        
        // Display welcome message
        log(chalk.cyan.bold('🎵 YouTube Music Downloader for Car Multimedia 🚗'));
        log(chalk.gray('Press q or Ctrl+C to exit at any time'));
        
        // Check terminal size and ensure screen is rendering
        checkTerminalSize();
        try {
            safeRender();
            console.log('Screen initialized and rendered');
        } catch (error) {
            console.error('Error rendering screen:', error);
        }
        
        // Check requirements
        if (!await checkRequirements()) {
            log(chalk.red('❌ Exiting due to missing requirements'));
            screen.key(['q', 'C-c'], () => cleanupAndExit(1));
            return;
        }
        
        // Create download and temp directories if they don't exist
        try {
            fs.ensureDirSync(downloadDirectory);
            fs.ensureDirSync(tempDirectory);
            log(chalk.green(`✓ Download directory ready: ${downloadDirectory}`));
            log(chalk.green(`✓ Temp directory ready: ${tempDirectory}`));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log(chalk.red(`❌ Failed to create directories: ${errorMessage}`));
            log(chalk.red(`Paths: ${downloadDirectory}, ${tempDirectory}`));
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
        appState.stats.totalTracks = allTracks.length;
        
        if (appState.stats.totalTracks === 0) {
            log(chalk.red('❌ No tracks found to download. Check your playlist and video URLs.'));
            process.exit(1);
        }
        
        log(chalk.green(`✓ Found ${appState.stats.totalTracks} total tracks to process`));

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
        log(chalk.white(`  Total tracks: ${appState.stats.totalTracks}`));
        log(chalk.green(`  Completed: ${appState.stats.completedTracks}`));
        log(chalk.red(`  Errors: ${appState.stats.errorTracks}`));
        log(chalk.yellow(`  Remaining: ${appState.stats.totalTracks - appState.stats.completedTracks - appState.stats.errorTracks}`));

        if (appState.stats.errorTracks > 0) {
            log(chalk.yellow(`⚠ Some tracks had errors. Check the state file for details: ${stateFile}`));
        }

        // Keep the screen open until user presses 'q'
        statusBox.setContent(chalk.green.bold('✅ Download complete! Press q to exit'));
        safeRender();
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(chalk.red(`❌ Fatal error in main function: ${errorMessage}`));
        if (error instanceof Error && error.stack) {
            log(chalk.red(`Stack trace: ${error.stack}`));
        }
        
        // Save current state
        try {
            fs.writeJsonSync(stateFile, appState, { spaces: 2 });
            log(chalk.yellow('✓ Saved current progress to state file'));
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
    
    cleanupAndExit(1);
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

// Function to clean up and exit
function cleanupAndExit(exitCode = 0) {
    log(chalk.yellow('Exiting application...'));
    
    // Kill all active processes
    if (activeProcesses.size > 0) {
        log(chalk.yellow(`Terminating ${activeProcesses.size} active processes...`));
        for (const proc of activeProcesses) {
            try {
                proc.kill('SIGTERM');
            } catch (error) {
                // Ignore errors when killing processes
            }
        }
    }
    
    // Save state before exit
    try {
        fs.writeJsonSync(stateFile, appState, { spaces: 2 });
        log(chalk.green('✓ State saved successfully'));
    } catch (error) {
        log(chalk.red(`❌ Error saving state: ${error}`));
    }
    
    // Final render attempt
    try {
        screen.render();
    } catch (error) {
        console.error('Error during final render:', error);
    }
    
    // Force exit after a brief delay to allow final logs
    setTimeout(() => process.exit(exitCode), 300);
}

// Fix for proper exit handling
screen.key(['q', 'C-c', 'C-d'], () => {
    cleanupAndExit(0);
});

// Handle process signals
process.on('SIGINT', () => {
    log(chalk.yellow('Received SIGINT signal (Ctrl+C)'));
    cleanupAndExit(0);
});

process.on('SIGTERM', () => {
    log(chalk.yellow('Received SIGTERM signal'));
    cleanupAndExit(0);
});

// Start the application
main().catch(error => {
    log(chalk.red(`❌ Fatal error: ${error}`));
    process.exit(1);
});
