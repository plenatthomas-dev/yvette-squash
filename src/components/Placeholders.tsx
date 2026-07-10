// États de remplacement (extraits de page.tsx) : squelette de chargement et état vide
// « présentable ». Composants purs, sans état.

// Squelette de chargement (à la place du texte « Chargement… »)
export function Skeleton() {
  return (
    <div className="grid-wrap skel" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <div className="skel-row" key={i}>
          <span className="skel-cell time" />
          <span className="skel-cell" />
          <span className="skel-cell" />
        </div>
      ))}
    </div>
  );
}

// État vide « présentable » (petit visuel + message) plutôt qu'un simple texte gris.
export function EmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">{icon}</span>
      <p>{text}</p>
    </div>
  );
}
