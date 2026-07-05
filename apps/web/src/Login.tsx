interface LoginProps {
  password: string;
  setPassword: (value: string) => void;
  onSubmit: () => void;
  error: boolean;
}

/**
 * 1-bit "codex" login screen — black & white, ordered dithering, an all-seeing-eye
 * emblem (we watch the AI reading your site), pixel font. Pure presentation; the
 * auth logic (password state + submit) is owned by the parent and passed in.
 */
export function Login({ password, setPassword, onSubmit, error }: LoginProps) {
  return (
    <div className="codex">
      <div className="codex-frame" aria-hidden="true" />
      <div className="codex-card" role="dialog" aria-label="Sign in">
        <svg className="codex-eye" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <defs>
            <pattern id="codexDither" width="4" height="4" patternUnits="userSpaceOnUse">
              <rect width="4" height="4" fill="#fff" />
              <rect width="2" height="2" fill="#000" />
              <rect x="2" y="2" width="2" height="2" fill="#000" />
            </pattern>
          </defs>
          <g stroke="#000" strokeWidth="1.4">
            <path d="M24 5 L24 0" />
            <path d="M10 10 L6 6" />
            <path d="M38 10 L42 6" />
            <path d="M5 24 L0 24" />
            <path d="M43 24 L48 24" />
            <path d="M10 38 L6 42" />
            <path d="M38 38 L42 42" />
          </g>
          <path d="M24 6 L43 24 L24 42 L5 24 Z" fill="url(#codexDither)" stroke="#000" strokeWidth="2.4" />
          <path d="M11 24 Q24 12 37 24 Q24 36 11 24 Z" fill="#fff" stroke="#000" strokeWidth="2.4" />
          <circle cx="24" cy="24" r="5.5" fill="#000" />
          <circle cx="22" cy="22" r="1.4" fill="#fff" />
        </svg>
        <h1 className="codex-title">CRAWLYTICS</h1>
        <p className="codex-sub">— enter the keep —</p>
        <input
          className="codex-input"
          type="password"
          placeholder="PASSWORD"
          aria-label="Dashboard password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onSubmit();
            }
          }}
        />
        {error ? <div className="codex-err">✗ wrong password</div> : null}
        <button className="codex-btn" onClick={onSubmit}>ENTER</button>
      </div>
    </div>
  );
}
