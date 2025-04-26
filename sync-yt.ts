import { execSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';

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
    [key: string]: boolean;
}

let cache: Cache = {};
let errors: Cache = {};

// Load cache
if (fs.existsSync(cacheFile)) {
    cache = fs.readJsonSync(cacheFile);
}

if (fs.existsSync(errorsFile)) {
    errors = fs.readJsonSync(errorsFile)
}

function downloadTrack(url: string) {
    if (cache[url]) {
        console.log(`Skipping already downloaded track: ${url}`);
        return;
    }
    if (errors[url]) {
        console.log(`Skipping previous error track: ${url}`);
        return;
    }

    const baseName = `video_${Date.now()}`;
    const tempOutputTemplate = path.join(downloadDirectory, `${baseName}.%(ext)s`);

    try {
        console.log(`Downloading track: ${url}`);

        execSync(`yt-dlp -i --no-overwrites -f "${fallbackFormat}" -o "${tempOutputTemplate}" --merge-output-format mp4 ${url}`, { stdio: 'inherit' });

        const files = fs.readdirSync(downloadDirectory).filter(f => f.startsWith(baseName));
        if (files.length === 0) throw new Error("No file downloaded");

        const downloadedFile = path.join(downloadDirectory, files[0]);
        const transcodedFile = path.join(downloadDirectory, `${baseName}_final.mp4`);

        execSync(`ffmpeg -y -i "${downloadedFile}" -c:v libx264 -profile:v baseline -level 3.0 -c:a aac "${transcodedFile}"`, { stdio: 'inherit' });

        fs.removeSync(downloadedFile); // delete original
        fs.renameSync(transcodedFile, path.join(downloadDirectory, `${baseName}.mp4`)); // rename final output

        cache[url] = true;
        fs.writeJsonSync(cacheFile, cache, { spaces: 2 });

        console.log(`Downloaded and transcoded to ${baseName}.mp4`);
    } catch (error) {
        console.error(`Failed to download track: ${url}\nError: ${error}`);
        errors[url] = true;
        fs.writeJsonSync(errorsFile, errors, { spaces: 2 });
    }
}

function getTracksFromPlaylist(url: string): string[] {
    try {
        const output = execSync(`yt-dlp --flat-playlist -J ${url}`, { encoding: 'utf-8' });
        const playlistData = JSON.parse(output);
        return playlistData.entries.map((entry: any) => `https://youtube.com/watch?v=${entry.id}`);
    } catch (error) {
        console.error(`Failed to fetch playlist: ${url}\nError: ${error}`);
        return [];
    }
}

function main() {
    for (const playlistUrl of playlistUrls) {
        const trackUrls = getTracksFromPlaylist(playlistUrl);
        for (const trackUrl of trackUrls) {
            downloadTrack(trackUrl);
        }
    }
    for (const videoUrl of videoUrls) {
        downloadTrack(videoUrl);
    }
}

main();
