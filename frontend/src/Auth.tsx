import { useState } from "react";
import { login, register } from "./api";

export default function Auth({ onAuth }: { onAuth: () => void }) {
  const [modo, setModo] = useState<"login" | "registro">("login");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      if (modo === "registro") await register(email.trim(), senha);
      else await login(email.trim(), senha);
      onAuth();
    } catch (e) {
      setError(String(e).replace("Error: ", ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>🎬 Nitro</h1>
        <p className="sub">{modo === "login" ? "Entre na sua conta" : "Crie sua conta"}</p>

        {error && <div className="error">⚠️ {error}</div>}

        <input
          type="email"
          placeholder="E-mail"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <input
          type="password"
          placeholder="Senha (mín. 6 caracteres)"
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        <button className="btn primary big" onClick={submit} disabled={busy}>
          {busy ? "..." : modo === "login" ? "Entrar" : "Criar conta"}
        </button>

        <div className="auth-switch">
          {modo === "login" ? (
            <>
              Não tem conta?{" "}
              <button className="linkbtn" onClick={() => setModo("registro")}>
                Cadastre-se
              </button>
            </>
          ) : (
            <>
              Já tem conta?{" "}
              <button className="linkbtn" onClick={() => setModo("login")}>
                Entrar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
