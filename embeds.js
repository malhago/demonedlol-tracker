const { EmbedBuilder } = require('discord.js');

// ─── Constants ────────────────────────────────────────────────────────────────

const QUEUE_NAMES = {
  420: 'Ranked Solo/Duo',
  440: 'Ranked Flex',
  400: 'Normal Draft',
  430: 'Normal Blind',
  450: 'ARAM',
  900: 'URF',
  1900: 'URF',
  1020: 'One for All',
  720: 'ARAM Clash',
  830: 'Co-op vs IA',
};

const POSITION_LABELS = {
  TOP: 'Top',
  JUNGLE: 'Jungle',
  MIDDLE: 'Mid',
  BOTTOM: 'ADC',
  UTILITY: 'Support',
  NONE: '',
};

// ─── Performance rank (1–10) ──────────────────────────────────────────────────

/**
 * Calcule le classement d'un participant parmi les 10 joueurs.
 * Formule : score composite = KDA pondéré + damage/1000 + vision + participation
 */
function getPerformanceRank(participant, allParticipants) {
  const score = (p) => {
    const kda =
      p.deaths === 0
        ? (p.kills + p.assists) * 1.5
        : (p.kills + p.assists) / p.deaths;

    const damageScore = (p.totalDamageDealtToChampions || 0) / 2000;
    const visionScore = (p.visionScore || 0) / 10;
    const killParticipation = p.challenges?.killParticipation || 0;

    return kda * 2 + damageScore + visionScore + killParticipation * 3;
  };

  const sorted = [...allParticipants].sort((a, b) => score(b) - score(a));
  return sorted.findIndex(p => p.puuid === participant.puuid) + 1;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatKDA(kills, deaths, assists) {
  const ratio =
    deaths === 0
      ? '∞'
      : ((kills + assists) / deaths).toFixed(2);
  return `**${kills}**/${deaths}/**${assists}** (${ratio} KDA)`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRank(entry) {
  if (!entry) return 'Non classé';
  return `${entry.tier} ${entry.rank} — ${entry.leaguePoints} LP`;
}

function formatLPChange(entry, lpChange, tierChanged, prevTier, prevRank) {
  const base = formatRank(entry);
  if (tierChanged && prevTier) {
    const direction =
      entry.tier > prevTier ? '**PROMOTION**' : 'Rétrogradation';
    return `${base}\n${direction} depuis ${prevTier} ${prevRank}`;
  }
  if (lpChange !== null && entry?.queueType !== undefined) {
    const sign = lpChange >= 0 ? '+' : '';
    return `${base}\n**${sign}${lpChange} LP**`;
  }
  return base;
}

function formatPerformanceRank(rank) {
  if (rank === 1) return '**MVP — #1/10**';
  if (rank === 10) return '**Dernier — #10/10**';
  return `**#${rank}/10**`;
}

// ─── Main embed builder ───────────────────────────────────────────────────────

/**
 * @param {Object} player        - Données stockées du joueur
 * @param {Object} match         - Réponse Match v5
 * @param {Object} participant   - Participant trouvé dans match.info.participants
 * @param {Object|null} entry    - Entrée ranked actuelle
 * @param {number|null} lpChange - Variation de LP (peut être null si non ranked)
 * @param {number} perfRank      - Classement 1–10 dans la partie
 * @param {string} championUrl   - URL de l'image du champion
 */
function buildGameEmbed({ player, match, participant, entry, lpChange, perfRank, championUrl }) {
  const win = participant.win;
  const queueId = match.info.queueId;
  const queueName = QUEUE_NAMES[queueId] || `Mode ${queueId}`;
  const isRanked = queueId === 420 || queueId === 440;

  const cs =
    (participant.totalMinionsKilled || 0) +
    (participant.neutralMinionsKilled || 0);
  const csMin = (cs / (match.info.gameDuration / 60)).toFixed(1);

  const position = POSITION_LABELS[participant.teamPosition] || '';
  const gameDate = formatDate(match.info.gameEndTimestamp || match.info.gameCreation);
  const duration = formatDuration(match.info.gameDuration);

  // LP info — seulement pour les parties ranked
  let lpField = isRanked
    ? formatLPChange(
        entry,
        lpChange,
        entry && player.currentTier && entry.tier !== player.currentTier,
        player.currentTier,
        player.currentRank
      )
    : formatRank(entry);

  const multikill = buildMultikillBadge(participant);

  const embed = new EmbedBuilder()
    .setColor(win ? 0x57f287 : 0xed4245)
    .setAuthor({
      name: `${player.gameName}#${player.tagLine} — ${queueName}`,
      iconURL: championUrl,
    })
    .setTitle(
      `${win ? 'VICTOIRE' : 'DÉFAITE'}${multikill ? ` ${multikill}` : ''}`
    )
    .setThumbnail(championUrl)
    .addFields(
      {
        name: 'Champion',
        value: `${position ? position + '\n' : ''}**${participant.championName}**\nNiv. ${participant.champLevel}`,
        inline: true,
      },
      {
        name: 'KDA',
        value: formatKDA(participant.kills, participant.deaths, participant.assists),
        inline: true,
      },
      {
        name: 'Farm',
        value: `${cs} CS (**${csMin}**/min)`,
        inline: true,
      },
      {
        name: 'Dégâts champions',
        value: `${(participant.totalDamageDealtToChampions || 0).toLocaleString('fr-FR')}`,
        inline: true,
      },
      {
        name: 'Vision',
        value: `${participant.visionScore || 0} pts`,
        inline: true,
      },
      {
        name: 'Classement ranked',
        value: lpField,
        inline: false,
      }
    )
    .setFooter({ text: `${gameDate} • ${duration}` });

  return embed;
}

function buildMultikillBadge(participant) {
  if (participant.pentaKills > 0) return '**PENTA KILL!**';
  if (participant.quadraKills > 0) return '**Quadra Kill!**';
  if (participant.tripleKills > 0) return 'Triple Kill';
  return '';
}

// ─── In-Game embed ───────────────────────────────────────────────────────────

function buildInGameEmbed({ player, championName, championUrl, queueName }) {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setAuthor({
      name: `${player.gameName}#${player.tagLine}`,
      iconURL: championUrl,
    })
    .setTitle('EN PARTIE')
    .setDescription(`**${player.gameName}** est actuellement en partie avec **${championName}**`)
    .setThumbnail(championUrl)
    .addFields({
      name: 'Mode',
      value: queueName,
      inline: true,
    })
    .setFooter({ text: new Date().toLocaleTimeString('fr-FR') });
}

// ─── Profile embed ──────────────────────────────────────────────────────────

const TIER_COLORS = {
  IRON: 0x6B6B6B,
  BRONZE: 0xCD7F32,
  SILVER: 0xC0C0C0,
  GOLD: 0xFFD700,
  PLATINUM: 0x00CED1,
  EMERALD: 0x50C878,
  DIAMOND: 0xB9F2FF,
  MASTER: 0x9B59B6,
  GRANDMASTER: 0xE74C3C,
  CHALLENGER: 0xF1C40F,
};

function buildProfileEmbed({ player, entry, peakTier, peakRank, peakLP, championStats, totalGames, emblemUrl, profileIconUrl }) {
  const color = (entry && TIER_COLORS[entry.tier]) || 0x7289DA;

  const rankStr = entry
    ? `${entry.tier} ${entry.rank} -- ${entry.leaguePoints} LP`
    : 'Non classe';

  const wl = entry
    ? `${entry.wins}V / ${entry.losses}D (${((entry.wins / (entry.wins + entry.losses)) * 100).toFixed(1)}%)`
    : 'N/A';

  const peakStr = peakTier
    ? `${peakTier} ${peakRank} -- ${peakLP} LP`
    : 'Non suivi';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: `${player.gameName}#${player.tagLine}`,
      iconURL: profileIconUrl || undefined,
    })
    .setTitle('PROFIL RANKED')
    .setThumbnail(emblemUrl || undefined)
    .addFields(
      { name: 'Classement', value: rankStr, inline: true },
      { name: 'W/L', value: wl, inline: true },
      { name: 'Pic de saison', value: peakStr, inline: true },
    );

  if (championStats && championStats.length > 0) {
    const lines = championStats.map((c, i) => {
      const wr = ((c.wins / c.games) * 100).toFixed(1);
      const kda = c.deaths === 0
        ? `${(c.kills / c.games).toFixed(1)}/0/${(c.assists / c.games).toFixed(1)}`
        : `${(c.kills / c.games).toFixed(1)}/${(c.deaths / c.games).toFixed(1)}/${(c.assists / c.games).toFixed(1)}`;
      const csMin = (c.cs / c.duration * 60).toFixed(1);
      return `\`${i + 1}.\` **${c.championName}** | ${c.games} games (${wr}% WR) | ${kda} KDA | ${csMin} CS/min`;
    });

    embed.addFields({
      name: `Top Champions (${totalGames} dernieres parties ranked)`,
      value: lines.join('\n'),
      inline: false,
    });
  } else {
    embed.addFields({
      name: 'Top Champions',
      value: 'Aucune partie ranked recente trouvee',
      inline: false,
    });
  }

  return embed;
}

module.exports = { buildGameEmbed, buildInGameEmbed, buildProfileEmbed, getPerformanceRank };
