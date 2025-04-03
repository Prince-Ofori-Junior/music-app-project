require('dotenv').config();  
const express = require("express");
const multer = require("multer");
const { Pool } = require("pg");
const path = require("path");
const pool = require("./database");
const fs = require("fs");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;  

app.use(express.json());
app.use(cors());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const uploadDir = "uploads/";
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const MAX_FILE_SIZE = 5 * 1024 * 1024;  
const fileFilter = (req, file, cb) => {
    const allowedTypes = /audio\/(mpeg|wav|flac|mp3)/; 
    const mimeType = file.mimetype;
    
    if (allowedTypes.test(mimeType)) {
        cb(null, true);
    } else {
        cb(new Error('Only audio files are allowed!'), false);
    }
};

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },  
    fileFilter: fileFilter               
}).array("file", 100);  


app.post("/upload", upload, async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No file(s) uploaded" });}
    try {
        const uploadedSongs = [];

        for (const file of req.files) {
            const { originalname } = file;
            const title = path.basename(originalname, path.extname(originalname));
            const existingSong = await pool.query("SELECT * FROM songs WHERE filename = $1", [originalname]);

            if (existingSong.rows.length > 0) {
                continue;}
            const result = await pool.query("INSERT INTO songs (title, filename) VALUES ($1, $2) RETURNING *",[title, originalname]);
            uploadedSongs.push(result.rows[0]); }

        if (uploadedSongs.length === 0) {
            return res.status(400).json({ error: "Uploaded song(s) already exist" });}
        res.json(uploadedSongs); 

    } catch (error) {
        console.error("Database Error:", error.message);
        res.status(500).json({ error: "Database insertion failed: " + error.message });
    }
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: "File is too large. Maximum size is 5MB." });

    } else if (err.message === 'Only audio files are allowed!') {
        return res.status(400).json({ error: "Only audio files are allowed!" });
    }
    next(err);
});



app.get("/songs/search", async (req, res) => {
    const { title } = req.query;
    let query = "SELECT * FROM songs";
    let params = [];

    if (title && title.trim() !== "") {
        query += " WHERE title ILIKE $1";
        params = [`%${title}%`];
    }
    try {
        const result = await pool.query(query, params);
        res.json(result.rows);  
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



app.post("/playlists", async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Playlist name is required" });

    try {
        const result = await pool.query("INSERT INTO playlists (name) VALUES ($1) RETURNING *",[name]);
        res.json(result.rows[0]); } 
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});



app.get("/playlists", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM playlists");
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



app.post("/playlists/:playlistName/add", async (req, res) => {
    const { playlistName } = req.params;
    const { songTitle } = req.body;
    if (!songTitle) return res.status(400).json({ error: "Song title is required" });
    try {
        const playlistResult = await pool.query("SELECT id FROM playlists WHERE name = $1", [playlistName]);
        if (playlistResult.rows.length === 0) {
            return res.status(404).json({ error: "Playlist not found" });
        }
        const playlistId = playlistResult.rows[0].id;

        const songResult = await pool.query("SELECT id FROM songs WHERE title = $1", [songTitle]);
        if (songResult.rows.length === 0) {
            return res.status(404).json({ error: "Song not found" });
        }
        const songId = songResult.rows[0].id;

        await pool.query("INSERT INTO playlist_songs (playlist_id, song_id) VALUES ($1, $2)", [playlistId, songId]);
        res.json({ message: `Added "${songTitle}" to "${playlistName}"` }); } 
    catch (error) {
        res.status(500).json({ error: error.message }); }
});



app.get("/playlists/:playlistName/songs", async (req, res) => {
    const { playlistName } = req.params;
    try {
        const playlistResult = await pool.query("SELECT id FROM playlists WHERE name = $1", [playlistName]);
        if (playlistResult.rows.length === 0) {
            return res.status(404).json({ error: "Playlist not found" }); }
        const playlistId = playlistResult.rows[0].id;
        const songsResult = await pool.query(`SELECT s.* FROM songs s JOIN playlist_songs ps ON s.id = ps.song_id WHERE ps.playlist_id = $1`,[playlistId]);
        res.json(songsResult.rows);}
     catch (error) {
        res.status(500).json({ error: error.message }); }
});



app.delete("/songs/delete/:title", async (req, res) => {
    const { title } = req.params; 
    try {
        const songResult = await pool.query("SELECT * FROM songs WHERE title = $1", [title]);
        if (songResult.rows.length === 0) {
            return res.status(404).json({ error: "Song not found" });}
        const song = songResult.rows[0];
        const songFilename = song.filename; 
        await pool.query("DELETE FROM songs WHERE title = $1", [title]);
        const filePath = path.join(__dirname, "uploads", songFilename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath); }
        res.json({ message: `Song with title "${title}" has been deleted successfully!` });
    } catch (error) {
        console.error("Error deleting song:", error.message);
        res.status(500).json({ error: "Failed to delete song" });
    }
});



app.delete("/playlists/delete/:name", async (req, res) => {
    const { name } = req.params; 
    try {
        const playlistResult = await pool.query("SELECT * FROM playlists WHERE name = $1", [name]);
        if (playlistResult.rows.length === 0) {
            return res.status(404).json({ error: "Playlist not found" });}
        await pool.query("DELETE FROM playlists WHERE name = $1", [name]);
        await pool.query("DELETE FROM playlist_songs WHERE playlist_id = (SELECT id FROM playlists WHERE name = $1)", [name]);
        res.json({ message: `Playlist "${name}" has been deleted successfully!` });} 
    catch (error) {
        console.error("Error deleting playlist:", error.message);
        res.status(500).json({ error: "Failed to delete playlist" });}
});



app.delete("/playlists/:playlistName/songs/delete/:songTitle", async (req, res) => {
    const { playlistName, songTitle } = req.params; 
    try {
        const playlistResult = await pool.query("SELECT id FROM playlists WHERE name = $1", [playlistName]);
        if (playlistResult.rows.length === 0) {
            return res.status(404).json({ error: "Playlist not found" });
        }
        const playlistId = playlistResult.rows[0].id;
        const songResult = await pool.query("SELECT id FROM songs WHERE title = $1", [songTitle]);
        if (songResult.rows.length === 0) {
            return res.status(404).json({ error: "Song not found" });
        }
        const songId = songResult.rows[0].id;
        await pool.query("DELETE FROM playlist_songs WHERE playlist_id = $1 AND song_id = $2", [playlistId, songId]);
        res.json({ message: `Song "${songTitle}" has been removed from the playlist "${playlistName}" successfully!` });}
     catch (error) {
        console.error("Error deleting song from playlist:", error.message);
        res.status(500).json({ error: "Failed to delete song from playlist" });}
});



app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
});
