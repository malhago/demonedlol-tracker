const fs = require('fs');
const path = require('path');

class Storage {
  constructor(filePath) {
    this.path = path.resolve(filePath);
    this.data = this._load();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch {
      return { players: {}, config: {} };
    }
  }

  _save() {
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf8');
  }

  // ─── Players ────────────────────────────────────────────────────────────────

  getPlayers() {
    return this.data.players;
  }

  getPlayer(key) {
    return this.data.players[key.toLowerCase()] || null;
  }

  setPlayer(key, playerData) {
    this.data.players[key.toLowerCase()] = playerData;
    this._save();
  }

  removePlayer(key) {
    delete this.data.players[key.toLowerCase()];
    this._save();
  }

  findPlayer(input) {
    // Recherche insensible à la casse avec ou sans # tag
    const lower = input.toLowerCase();
    const players = this.data.players;

    // Exact match
    if (players[lower]) return players[lower];

    // Partial match sur gameName seulement
    const found = Object.values(players).find(p =>
      p.gameName.toLowerCase() === lower
    );
    return found || null;
  }

  // ─── Config ─────────────────────────────────────────────────────────────────

  getConfig() {
    return this.data.config;
  }

  setConfig(key, value) {
    this.data.config[key] = value;
    this._save();
  }
}

module.exports = { Storage };
