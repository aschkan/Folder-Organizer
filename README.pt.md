<div align="center">

# 📁 Folder Organizer (Organizador de Pastas)

**Uma ferramenta local, privada e assistida por IA que organiza com segurança as suas pastas mais bagunçadas em categorias — sem nunca quebrar os seus aplicativos, projetos de código ou bancos de dados — com reversão completa em um clique.**

Tudo roda na sua própria máquina. Nada é enviado para a nuvem. Nada é movido até você revisar e confirmar.

[English](README.md) ·
[فارسی](README.fa.md) ·
[العربية](README.ar.md) ·
[Español](README.es.md) ·
[中文](README.zh.md) ·
[हिन्दी](README.hi.md) ·
[Русский](README.ru.md) ·
[Français](README.fr.md) ·
[Deutsch](README.de.md) ·
🌐 **Português** ·
[日本語](README.ja.md) ·
[Türkçe](README.tr.md)

</div>

---

## ✨ O que o torna diferente

A maioria dos "organizadores de arquivos" simplesmente joga tudo em pastas por extensão — e, ao fazer isso, **quebra** o que só funciona como um todo: um projeto de código, um app portátil, um banco de dados, uma página web salva. Este app entende a estrutura:

- 🛡️ **Mantém unidades inteiras intactas.** Projetos de código (`package.json`, `.git`, …), aplicativos e programas (apps portáteis, navegadores, emuladores, jogos — até binários Linux/macOS sem extensão), bancos de dados (SQLite, LevelDB/RocksDB) e páginas web salvas (pastas `..._files`) são movidos como **uma peça só**, nunca espalhados.
- 🤖 **Movido a IA, não uma lista fixa.** As categorias não são fixas no código. Um **LLM local (opcional)** classifica tipos desconhecidos com o contexto do caminho completo e pode inventar novas categorias — e, ao fim de cada varredura, **revisa o plano inteiro para corrigir os próprios erros**.
- ⏪ **Totalmente reversível.** Cada execução gera um snapshot; um clique devolve tudo exatamente ao lugar de origem.
- 💾 **À prova de falhas.** Se o PC ou o app desligar no meio, ele retoma exatamente de onde parou.
- 🔒 **100% local e privado.** Sem nuvem, sem telemetria, sem conta.

---

## 🚀 Início rápido

```bash
npm install
npm start
```

Depois abra **http://localhost:4173** no navegador.
(Mude a porta com `PORT=5000 npm start`.)

---

## 🧩 O que faz

- 🗂️ **Categorização inteligente** — imagens, vídeo, música, documentos, código, **modelos** (pesos de ML), **bancos de dados**, arquivos compactados, **atalhos**, **config** e mais — além de qualquer categoria criada por você ou pela IA.
- 🛡️ **Mantém intactos** projetos, aplicativos, bancos de dados e páginas web salvas.
- 🤖 **LLM local (opcional)** — classifica tipos desconhecidos e faz uma **revisão final de todos os arquivos**.
- 🔁 **Detecção de duplicatas** — exatas (por hash de conteúdo) e fotos visualmente semelhantes.
- 🧹 **Limpeza** de `node_modules`, caches de build e lixo do sistema.
- 📸 **Subpastas inteligentes** — fotos por data EXIF, música por artista/álbum.
- 👀 **Revise antes de mover** — veja o plano completo, edite, exclua o que quiser.
- ⏪ **Reversão + snapshots** da estrutura de pastas para cada execução.
- 💾 **Retomada automática** após uma interrupção.
- 📊 **Progresso ao vivo e registro em tempo real.**

---

## 🔒 Privacidade

É um utilitário pessoal de desktop: sem login, sem multiusuário, sem nuvem, sem telemetria. Todo o estado (regras de categoria aprendidas, snapshots de varredura, histórico para desfazer) fica em uma pasta local `data/` ao lado do app. Se você ativar o LLM opcional, as requisições vão apenas para o endpoint local que **você** configurar.
