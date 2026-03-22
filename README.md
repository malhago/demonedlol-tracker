# 🎮 LoL Discord Bot

Bot Discord de tracking League of Legends — affiche automatiquement les stats de fin de partie pour les joueurs enregistrés.

## ✨ Fonctionnalités

- **Détection automatique** des nouvelles parties (polling toutes les N minutes)
- **Embed détaillé** avec : victoire/défaite, champion, KDA, CS, dégâts, vision
- **LP gagné/perdu** pour les parties Ranked Solo/Duo
- **Rank dans la partie (1–10)** basé sur un score composite (KDA + dégâts + vision + kill participation)
- **Rang actuel** (Tier + Division + LP)
- **Badge Multikill** (Triple / Quadra / Penta Kill)
- **Commandes slash** modernes

## 🚀 Installation

### 1. Prérequis
- Node.js ≥ 16.9.0
- Un bot Discord créé sur [Discord Developer Portal](https://discord.com/developers/applications)
- Une clé API Riot Games sur [developer.riotgames.com](https://developer.riotgames.com/)

### 2. Créer le bot Discord

1. Va sur [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. Onglet **Bot** → Crée un bot → copie le **Token**
3. Onglet **General Information** → copie l'**Application ID**
4. Onglet **OAuth2 → URL Generator** :
   - Scopes : `bot` + `applications.commands`
   - Bot Permissions : `Send Messages`, `Embed Links`, `View Channels`
   - Copie l'URL générée et invite le bot sur ton serveur

### 3. Clé API Riot Games

1. Connecte-toi sur [developer.riotgames.com](https://developer.riotgames.com/)
2. **Development API Key** pour les tests (expire toutes les 24h)
3. Pour un usage permanent : demande une **Production API Key** (formulaire sur le site)

### 4. Configuration

```bash
# Clone / copie le projet
npm install

# Copie et remplis le fichier de config
cp .env.example .env
# Édite .env avec tes clés
```

### 5. Lancer le bot

```bash
npm start

# Mode développement (rechargement auto)
npm run dev
```

## 📖 Commandes

| Commande | Description |
|----------|-------------|
| `/register Pseudo#Tag région` | Enregistre un joueur à suivre |
| `/unregister Pseudo#Tag` | Supprime un joueur de la liste |
| `/lastgame [Pseudo#Tag]` | Affiche les stats de la dernière partie |
| `/list` | Liste tous les joueurs suivis et leur rank |
| `/setchannel #salon` | Définit où les résultats sont postés automatiquement |
| `/check` | Force la vérification immédiate des nouvelles parties |

## 🔄 Fonctionnement du polling

Le bot vérifie toutes les **3 minutes** (configurable) si un joueur a joué une nouvelle partie.  
Si oui, il poste automatiquement l'embed dans le salon configuré via `/setchannel`.

## 🏆 Calcul du rang dans la partie (1–10)

Le rank est calculé avec un score composite :
```
score = KDA × 2 + (dégâts/2000) + (vision/10) + kill_participation × 3
```
- **#1** = MVP 🏆
- **#10** = Dernier 💀

## 📊 Calcul du gain/perte de LP

Le gain de LP est calculé en comparant le LP **avant** et **après** la partie.  
La première partie après `/register` n'aura pas de gain LP affiché (pas de référence initiale).  
Les promotions/rétrogradations sont détectées automatiquement.

## ⚠️ Limites API Riot

La clé Development est limitée à **20 req/sec** et **100 req/2min**.  
Pour un grand nombre de joueurs, augmente `POLL_INTERVAL_MINUTES`.

## Security

- Ne commit jamais `.env` — utilise `.env.example` comme référence
- `data.json` est dans `.gitignore` (contient des données de joueurs)
- Les clés API sont chargées via variables d'environnement uniquement
