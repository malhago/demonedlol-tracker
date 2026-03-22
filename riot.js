const fetch = require('node-fetch');

// Mapping région courte → platform routing (ex: euw → euw1)
const SHORT_TO_PLATFORM = {
  euw: 'euw1', eune: 'eun1', na: 'na1', kr: 'kr',
  br: 'br1', lan: 'la1', las: 'la2', oce: 'oc1',
  tr: 'tr1', ru: 'ru', jp: 'jp1',
};

// Mapping platform → regional cluster (pour Match v5 & Account v1)
const PLATFORM_TO_REGIONAL = {
  br1: 'americas', eun1: 'europe', euw1: 'europe', jp1: 'asia',
  kr: 'asia', la1: 'americas', la2: 'americas', na1: 'americas',
  oc1: 'sea', tr1: 'europe', ru: 'europe',
};

// Ordre des tiers pour détecter promos/rétros
const TIER_ORDER = {
  IRON: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4,
  EMERALD: 5, DIAMOND: 6, MASTER: 7, GRANDMASTER: 8, CHALLENGER: 9,
};

class RiotAPI {
  constructor(apiKey) {
    if (!apiKey) throw new Error('RIOT_API_KEY manquante dans les variables d\'environnement.');
    this.apiKey = apiKey;
    this._ddVersion = null;
  }

  // ─── HTTP Base ──────────────────────────────────────────────────────────────

  async _fetch(url, retries = 1) {
    const res = await fetch(url, { headers: { 'X-Riot-Token': this.apiKey } });
    if (res.status === 429 && retries > 0) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '2') * 1000;
      await new Promise(r => setTimeout(r, retryAfter));
      return this._fetch(url, retries - 1);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body?.status?.message || res.statusText;
      throw new Error(`Riot API [${res.status}] ${msg}`);
    }
    return res.json();
  }

  // ─── Routing Helpers ────────────────────────────────────────────────────────

  getPlatform(regionShort) {
    return SHORT_TO_PLATFORM[regionShort.toLowerCase()] || regionShort.toLowerCase();
  }

  getRegional(platform) {
    return PLATFORM_TO_REGIONAL[platform] || 'europe';
  }

  compareTier(tierA, tierB) {
    return (TIER_ORDER[tierA] ?? -1) - (TIER_ORDER[tierB] ?? -1);
  }

  // ─── DDragon ────────────────────────────────────────────────────────────────

  async getDDragonVersion() {
    if (this._ddVersion) return this._ddVersion;
    const versions = await fetch('https://ddragon.leagueoflegends.com/api/versions.json').then(r => r.json());
    this._ddVersion = versions[0];
    return this._ddVersion;
  }

  async getChampionImageUrl(championName) {
    const v = await this.getDDragonVersion();
    return `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${championName}.png`;
  }

  async getProfileIconUrl(profileIconId) {
    const v = await this.getDDragonVersion();
    return `https://ddragon.leagueoflegends.com/cdn/${v}/img/profileicon/${profileIconId}.png`;
  }

  // ─── Account & Summoner ─────────────────────────────────────────────────────

  async getAccountByRiotId(gameName, tagLine, regional) {
    return this._fetch(
      `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );
  }

  async getSummonerByPuuid(puuid, platform) {
    return this._fetch(`https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`);
  }

  // ─── League / Ranked ────────────────────────────────────────────────────────

  async getLeagueEntries(puuid, platform) {
    return this._fetch(`https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`);
  }

  getRankedEntry(entries) {
    return (
      entries.find(e => e.queueType === 'RANKED_SOLO_5x5') ||
      entries.find(e => e.queueType === 'RANKED_FLEX_SR') ||
      null
    );
  }

  // ─── Match v5 ───────────────────────────────────────────────────────────────

  async getRecentMatchIds(puuid, regional, count = 1, queueId = null) {
    const queueParam = queueId ? `&queue=${queueId}` : '';
    return this._fetch(
      `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${count}${queueParam}`
    );
  }

  async getMatch(matchId, regional) {
    return this._fetch(`https://${regional}.api.riotgames.com/lol/match/v5/matches/${matchId}`);
  }

  // ─── Spectator v5 ──────────────────────────────────────────────────────────

  getRankEmblemUrl(tier) {
    if (!tier) return null;
    const tierLower = tier.toLowerCase();
    return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/${tierLower}.png`;
  }

  // Compare deux ranks complets: retourne > 0 si A est meilleur que B
  compareRank(tierA, rankA, lpA, tierB, rankB, lpB) {
    const RANK_ORDER = { IV: 0, III: 1, II: 2, I: 3 };
    const tierDiff = (TIER_ORDER[tierA] ?? -1) - (TIER_ORDER[tierB] ?? -1);
    if (tierDiff !== 0) return tierDiff;
    const rankDiff = (RANK_ORDER[rankA] ?? 0) - (RANK_ORDER[rankB] ?? 0);
    if (rankDiff !== 0) return rankDiff;
    return (lpA ?? 0) - (lpB ?? 0);
  }

  // ─── Spectator v5 ──────────────────────────────────────────────────────────

  async getActiveGame(puuid, platform) {
    const url = `https://${platform}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}`;
    const res = await fetch(url, { headers: { 'X-Riot-Token': this.apiKey } });
    if (res.status === 404) return null; // pas en game
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Riot API [${res.status}] ${body?.status?.message || res.statusText}`);
    }
    return res.json();
  }
}

module.exports = { RiotAPI };
