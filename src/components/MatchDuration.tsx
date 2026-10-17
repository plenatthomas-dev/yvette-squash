import { formatDuration, matchDurationMs, type TimedMatch } from "@/lib/interclub-duree";

/**
 * Durée d'un simple, à la suite de son numéro : « Simple 1 · 42 min ». Pendant le match, le
 * temps écoulé depuis le premier point — l'appelant fait avancer `now` (cf. `useMinuteClock`).
 *
 * Rien du tout quand on ne sait pas (score saisi après coup, match d'avant la mesure) : pas de
 * « — » ni de « durée inconnue », qui encombreraient chaque carte pour ne rien dire.
 */
export default function MatchDuration({ match, now }: { match: TimedMatch; now: number }) {
  const ms = matchDurationMs(match, now);
  if (ms === null) return null;
  return (
    <span className="ic-duration">
      <span aria-hidden="true"> · </span>
      <span className="sr-only">{match.status === "live" ? ", en jeu depuis " : ", durée "}</span>
      {formatDuration(ms)}
    </span>
  );
}
