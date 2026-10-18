import { initBotId } from "botid/client/core";

// Vercel BotID : instrumente le client pour protéger les endpoints sensibles contre les bots
// (invisible pour l'utilisateur, aucun champ ni captcha). La vérification serveur se fait avec
// checkBotId() dans chaque route listée ici — les deux doivent rester synchronisées.
// Ici : les demandes d'inscription et de réinitialisation (spam de la file d'attente admin), et
// la connexion ResaMania (essais de mots de passe en masse — audit 2026-10, point 23).
initBotId({
  protect: [
    { path: "/api/auth/login", method: "POST" },
    { path: "/api/auth/email/register", method: "POST" },
    { path: "/api/auth/email/forgot", method: "POST" },
  ],
});
