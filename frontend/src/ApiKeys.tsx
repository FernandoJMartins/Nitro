import { useEffect, useState } from "react";
import { ErrorBanner, confirmar } from "./Dialog";
import { createKey, deleteKey, listKeys, type ApiKey } from "./api";

export default function ApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [nome, setNome] = useState("");
  const [novaChave, setNovaChave] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listKeys().then(setKeys).catch((e) => setError(String(e)));
  }
  useEffect(refresh, []);

  async function criar() {
    setError(null);
    try {
      const k = await createKey(nome.trim() || "Minha chave");
      setNovaChave(k.chave);
      setNome("");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <p className="sub">
        Chaves para integrar sistemas externos. Use no cabeçalho{" "}
        <code>Authorization: Bearer &lt;chave&gt;</code> nos mesmos endpoints da API.
      </p>
      <ErrorBanner error={error} onClose={() => setError(null)} />

      <div className="uploader" style={{ flexDirection: "row", alignItems: "center" }}>
        <input
          placeholder="Nome da chave (ex.: n8n, Zapier)"
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="btn primary" onClick={criar}>
          + Gerar chave
        </button>
      </div>

      {novaChave && (
        <div className="keybox">
          <strong>⚠️ Copie agora — esta chave só aparece uma vez:</strong>
          <code className="keyval">{novaChave}</code>
          <button className="btn" onClick={() => navigator.clipboard.writeText(novaChave)}>
            Copiar
          </button>
        </div>
      )}

      <ul className="list">
        {keys.map((k) => (
          <li key={k.id} className="card">
            <div className="card-main">
              <strong>{k.nome}</strong>
              <div className="meta">
                {k.prefixo}••••••• · {k.ativo ? "ativa" : "revogada"}
              </div>
            </div>
            <div className="card-actions">
              <button
                className="btn danger"
                onClick={async () => {
                  if (
                    await confirmar({
                      title: "Revogar esta chave?",
                      message: `A chave "${k.nome}" vai parar de funcionar. Sistemas que usam ela não vão mais conseguir acessar o Nitro.`,
                      confirmLabel: "Revogar chave",
                    })
                  ) {
                    await deleteKey(k.id);
                    refresh();
                  }
                }}
              >
                Revogar
              </button>
            </div>
          </li>
        ))}
        {keys.length === 0 && <li className="empty">Nenhuma chave ainda.</li>}
      </ul>

      <div className="apidoc">
        <h3>📖 Exemplo de uso</h3>
        <pre>{`curl -X GET \\
  "${location.origin}/api/v1/videos/history" \\
  -H "Authorization: Bearer SUA_CHAVE"`}</pre>
        <p className="hint">Documentação completa e interativa em <code>/docs</code> (Swagger).</p>
      </div>
    </>
  );
}
