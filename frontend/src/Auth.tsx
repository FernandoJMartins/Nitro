import { useState } from "react";
import { ErrorBanner } from "./Dialog";
import { login, register } from "./api";
import { irPara } from "./nav";

export default function Auth({ onAuth, inicial = "login" }: { onAuth: () => void; inicial?: "login" | "registro" }) {
  const [modo, setModo] = useState<"login" | "registro">(inicial);
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
        <h1>Nitro</h1>
        <p className="sub">{modo === "login" ? "Entre na sua conta" : "Crie sua conta"}</p>

        <ErrorBanner error={error} onClose={() => setError(null)} />

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
        {modo === "registro" && (
          <p className="sub" style={{ fontSize: 12, marginTop: 12 }}>
            Ao criar a conta você concorda com os{" "}
            <a href="/termos" onClick={(e) => { e.preventDefault(); irPara("/termos"); }}>Termos de Uso</a> e a{" "}
            <a href="/privacidade" onClick={(e) => { e.preventDefault(); irPara("/privacidade"); }}>Política de Privacidade</a>.
          </p>
        )}
        <button className="linkbtn" style={{ marginTop: 12 }} onClick={() => irPara("/")}>
          ← Voltar para o início
        </button>
      </div>
    </div>
  );
}
