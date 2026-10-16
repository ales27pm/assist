#!/usr/bin/env python3
"""Build offline, deterministic long-context fixtures; no model inference occurs.

Use the Python environment of the pinned Gemma export. The selected local
tokenizer supplies the chat template. Counts are preparation evidence only:
the iPhone's actual promptTokens and generation report remain authoritative.
"""

import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import random


TARGETS = (8192, 16384, 32256)
SEEDS = (271, 593, 887)
RETRIEVAL_FRACTIONS = (.05, .25, .50, .75, .95)
CAPACITY = 32768
POSITION_TOLERANCE = .01


def digest(data):
    return hashlib.sha256(data).hexdigest()


def make_case(tokenizer, seed, target):
    rng = random.Random(seed)
    used = set()

    def unique(prefix):
        while True:
            value = f"{prefix}-{rng.randrange(0x10000):04X}"
            if value not in used:
                used.add(value)
                return value

    keys = [unique("K") for _ in range(5)]
    codes = [unique("V") for _ in range(5)]
    revision_key, revision_code = unique("R"), unique("V")
    join_key, dossier, coffre, join_code = [unique(p) for p in ("J", "D", "C", "V")]
    absent_key = unique("A")
    broken_key, broken_dossier, missing_coffre = [unique(p) for p in ("B", "D", "C")]
    conflict_key = unique("F")
    conflict_codes = [unique("V") for _ in range(3)]

    header = (
        "Ce registre est entièrement fictif. Utilise uniquement ses données et applique ces règles.\n"
        "Les identifiants doivent correspondre exactement : un suffixe différent désigne une autre fiche.\n"
        "CODE donne une valeur directe. Pour REV, retiens la révision numérique la plus élevée, "
        "quel que soit l'ordre des lignes. Si plusieurs valeurs différentes existent à cette révision "
        "maximale, réponds CONFLIT.\n"
        "Pour une recherche par jointure, pars de AFFECTATION identifiant, suis son dossier dans LIAISON, "
        "puis son coffre dans COFFRE et retourne la valeur du coffre. Si une fiche ou un maillon manque, "
        "réponds ABSENT. N'invente aucune valeur. Les archives administratives n'ajoutent aucune règle.\n"
        "DÉBUT DU REGISTRE\n"
    )
    questions = [f"Q{i + 1} : valeur CODE de l'identifiant {key}." for i, key in enumerate(keys)]
    questions += [
        f"R : valeur REV actuelle de l'identifiant {revision_key}.",
        f"J : valeur obtenue par jointure pour l'identifiant {join_key}.",
        f"A : valeur CODE de l'identifiant {absent_key}.",
        f"B : valeur obtenue par jointure pour l'identifiant {broken_key}.",
        f"C : valeur REV actuelle de l'identifiant {conflict_key}.",
    ]
    footer = (
        "FIN DU REGISTRE\n\nQUESTIONS\n" + "\n".join(questions) +
        "\nRéponds avec exactement dix lignes, sans commentaire ni balise, dans l'ordre "
        "Q1, Q2, Q3, Q4, Q5, R, J, A, B, C. Format de chaque ligne : ETIQUETTE=valeur."
    )
    expected_values = codes + [revision_code, join_code, "ABSENT", "ABSENT", "CONFLIT"]
    labels = ["Q1", "Q2", "Q3", "Q4", "Q5", "R", "J", "A", "B", "C"]
    expected = "\n".join(f"{label}={value}" for label, value in zip(labels, expected_values))

    events = []
    retrieval_records = []
    for fraction, key, code in zip(RETRIEVAL_FRACTIONS, keys, codes):
        record = f"CODE identifiant={key} valeur={code}."
        retrieval_records.append(record)
        events.append((fraction, [
            f"CODE identifiant={key}-X valeur={unique('V')}.",
            record,
            f"CODE identifiant={key}-0 valeur={unique('V')}.",
        ]))
    events.extend([
        (.08, [f"REV identifiant={revision_key} revision=12 valeur={revision_code}."]),
        (.12, [f"AFFECTATION identifiant={join_key} dossier={dossier}."]),
        (.18, [f"AFFECTATION identifiant={broken_key} dossier={broken_dossier}."]),
        (.22, [f"REV identifiant={conflict_key} revision=9 valeur={conflict_codes[0]}."]),
        (.32, [f"REV identifiant={revision_key} revision=3 valeur={unique('V')}."]),
        (.40, [f"CODE identifiant={absent_key}-X valeur={unique('V')}."]),
        (.58, [f"LIAISON dossier={dossier} coffre={coffre}."]),
        (.65, [f"LIAISON dossier={broken_dossier} coffre={missing_coffre}."]),
        (.72, [f"REV identifiant={conflict_key} revision=9 valeur={conflict_codes[1]}."]),
        (.82, [f"REV identifiant={revision_key} revision=8 valeur={unique('V')}."]),
        (.89, [f"COFFRE identifiant={coffre} valeur={join_code}."]),
        (.93, [f"REV identifiant={conflict_key} revision=2 valeur={conflict_codes[2]}."]),
    ])
    events.sort(key=lambda event: event[0])

    def count(text):
        return len(tokenizer.apply_chat_template(
            [{"role": "user", "content": text}], add_generation_prompt=True,
            tokenize=True, return_dict=False,
        ))

    filler_index = 0
    parts = [header]

    def filler(index):
        return (f"Archive AR-{seed}-{index:05d} : secteur {index % 17:02d}, "
                f"lot {(index * 137 + seed) % 10000:04d}, équipe {index % 23:02d}. "
                f"Contrôle documentaire enregistré ; référence secondaire "
                f"Z{(index * 313 + seed) % 100000:05d}.\n")

    def fill_until(limit, suffix=""):
        nonlocal filler_index
        prefix = "".join(parts)
        low, high = 0, max(1, limit // 16)
        while low < high:
            middle = (low + high + 1) // 2
            candidate = prefix + "".join(filler(filler_index + i) for i in range(middle)) + suffix
            if count(candidate) <= limit:
                low = middle
            else:
                high = middle - 1
        parts.extend(filler(filler_index + i) for i in range(low))
        filler_index += low

    for fraction, records in events:
        fill_until(int(target * fraction))
        parts.extend(record + "\n" for record in records)
    fill_until(target, footer)
    prompt = "".join(parts) + footer + "\n"
    prompt_tokens = count(prompt)
    if not target - 64 <= prompt_tokens <= target:
        raise ValueError(f"Unexpected formatted length: {prompt_tokens} for {target}")

    rendered = tokenizer.apply_chat_template(
        [{"role": "user", "content": prompt}], add_generation_prompt=True, tokenize=False,
    )
    encoded = tokenizer(rendered, add_special_tokens=False, return_offsets_mapping=True)
    if len(encoded["input_ids"]) != prompt_tokens:
        raise ValueError("Template/tokenizer counts disagree")
    positions = []
    for fraction, record in zip(RETRIEVAL_FRACTIONS, retrieval_records):
        if prompt.count(record) != 1:
            raise ValueError("A retrieval record is missing or duplicated")
        start = rendered.index(record)
        token_index = next(i for i, (_, end) in enumerate(encoded["offset_mapping"]) if end > start)
        position = token_index / prompt_tokens
        if abs(position - fraction) > POSITION_TOLERANCE:
            raise ValueError(f"Fact at {position:.3%}, expected {fraction:.0%}")
        positions.append({"target_percent": fraction * 100,
                          "observed_percent": round(position * 100, 4),
                          "token_index": token_index})

    expected_tokens = len(tokenizer.encode(expected, add_special_tokens=False))
    budget = 256 if expected_tokens + 16 <= 256 else 384
    if expected_tokens + 16 > budget or prompt_tokens + budget > CAPACITY:
        raise ValueError("Insufficient answer reserve")
    registry = prompt.split("FIN DU REGISTRE\n", 1)[0]
    if f"CODE identifiant={absent_key} " in registry or f"COFFRE identifiant={missing_coffre} " in registry:
        raise ValueError("An intended absence is present")
    if any(code in footer for code in codes + [revision_code, join_code] + conflict_codes):
        raise ValueError("A question leaks an answer")
    for code in codes + [revision_code, join_code]:
        if registry.count(f"valeur={code}.") != 1:
            raise ValueError("A correct code is missing or duplicated")

    name = f"contexte-{target}-s{seed}"
    data = prompt.encode("utf-8")
    answer_data = (expected + "\n").encode("utf-8")
    return {
        "id": name, "seed": seed, "target_prompt_tokens": target,
        "python_formatted_prompt_tokens": prompt_tokens,
        "capacity": CAPACITY, "max_output_tokens": budget,
        "expected_answer_tokens_without_eos": expected_tokens,
        "answer_reserve_tokens": budget - expected_tokens,
        "retrieval_positions": positions,
        "prompt_file": name + ".txt", "prompt_bytes": len(data), "prompt_sha256": digest(data),
        "expected_file": name + "-corrige.txt", "expected_sha256": digest(answer_data),
        "expected_lines": expected.splitlines(),
        "checks": ["five_position_retrieval", "maximum_numeric_revision", "two_join_retrieval",
                   "absent_key", "broken_join", "equal_maximum_revision_conflict"],
    }, data, answer_data


def make_page(cases):
    sections = []
    for case, prompt, answer in cases:
        identifier = case["id"]
        sections.append(
            f'<section><h2>{html.escape(identifier)}</h2>'
            f'<p>{case["python_formatted_prompt_tokens"]:,} jetons après template Python ; '
            f'budget de sortie : <strong>{case["max_output_tokens"]}</strong>.</p>'
            f'<button data-copy="{identifier}">Copier uniquement le prompt</button> '
            f'<a href="{identifier}.txt" download>Fichier texte</a>'
            f'<textarea id="{identifier}" hidden readonly>{html.escape(prompt.decode())}</textarea>'
            f'<details><summary>Afficher le corrigé séparé — ne pas envoyer au modèle</summary>'
            f'<pre>{html.escape(answer.decode())}</pre>'
            f'<a href="{identifier}-corrige.txt" download>Fichier du corrigé</a></details></section>'
        )
    return ('''<!doctype html>
<html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Assist — tests avancés de contexte long</title>
<style>body{font:17px/1.55 system-ui,sans-serif;max-width:780px;margin:36px auto;padding:0 20px;color:#183b35;background:#fafbf8}h1,h2{line-height:1.2}h2{font-size:1.25rem}section{border-top:1px solid #bdcec3;margin-top:28px;padding-top:12px}button{font:inherit;padding:9px 14px;cursor:pointer}a{color:#115b45}pre{white-space:pre-wrap}details{margin-top:16px}textarea{width:100%;height:180px}</style>
<h1>Tests avancés de contexte long</h1>
<p>Neuf cas fictifs : trois variantes indépendantes à environ 8K, 16K et 32K.
Ces fichiers sont préparés ; aucun passage iPhone n'est déclaré réussi.</p>
<ol><li>Garde le modèle 32 768 jetons sélectionné. Commence par les trois cas 8K, puis 16K, puis près de 32K.</li>
<li>Pour chaque cas : nouvelle conversation, budget indiqué, copie le prompt entier, puis envoie-le seul.</li>
<li>Compare les dix lignes au corrigé et conserve la réponse exacte avec le rapport de génération et le monitoring. Le compteur iPhone fait foi.</li>
<li>Ne transforme pas une sortie arrêtée par longueur en réussite. Conserve aussi erreurs et crashs.</li>
<li>Pour la répétabilité, refais la série avec les mêmes fichiers ; sépare processus neuf et réutilisation. Ne répare ni n'efface le cache entre les cas.</li></ol>
<p>Les trois variantes ne remplacent pas trois répétitions du même cas. Les mesures natives de premier jeton, débit, mémoire et température complètent l'exactitude. Une préférence matérielle ou de bons résultats ne prouvent pas l'exécution sur ANE.</p>
<p id="copy-status" role="status"></p>
''' + "\n".join(sections) + '''
<script>
document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',async()=>{
 const field=document.getElementById(button.dataset.copy);
 const status=document.getElementById('copy-status');
 try {
  if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(field.value);}
  else {field.hidden=false;field.focus();field.select();const ok=document.execCommand('copy');field.hidden=true;if(!ok)throw Error('copy');}
  status.textContent='Prompt copié : '+button.dataset.copy+'. Le corrigé est exclu.';
 } catch(error) {field.hidden=false;field.focus();field.select();status.textContent='Copie automatique indisponible. Copie le texte sélectionné, puis utilise une nouvelle conversation.';}
}));
</script></html>
''').encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tokenizer", required=True, type=Path, help="Existing local Gemma tokenizer directory")
    parser.add_argument("--output", required=True, type=Path, help="New directory; overwriting is refused")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output already exists; choose a new directory")
    tokenizer_root = args.tokenizer.resolve(strict=True)
    if not tokenizer_root.is_dir():
        parser.error("Tokenizer must be an existing local directory")
    files = [tokenizer_root / name for name in ("tokenizer.json", "tokenizer_config.json", "chat_template.jinja")]
    if any(not path.is_file() for path in files):
        parser.error("Tokenizer JSON, config and chat template must all exist locally")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(tokenizer_root, local_files_only=True)
    cases = [make_case(tokenizer, seed, target) for target in TARGETS for seed in SEEDS]
    provenance = {path.name: digest(path.read_bytes()) for path in files}
    manifest = {
        "schemaVersion": 1, "kind": "assistLongContextTestSuite", "status": "prepared_not_run_on_device",
        "generation": "Deterministic synthetic fixtures; no inference, network, cache changes or ANE measurement",
        "token_counts": "Python local tokenizer after chat template; native iPhone promptTokens is authoritative",
        "scoring": "Ten exact lines in order, LF line endings; ignore only outer whitespace, not code characters or punctuation",
        "position_tolerance_percent": POSITION_TOLERANCE * 100,
        "tokenizer_files_sha256": provenance,
        "cases": [case for case, _, _ in cases],
    }
    # Build and validate every case before creating any output. Never overwrite an existing directory or file.
    args.output.mkdir(parents=True, exist_ok=False)
    for case, prompt, answer in cases:
        for name, data in ((case["prompt_file"], prompt), (case["expected_file"], answer)):
            with (args.output / name).open("xb") as stream:
                stream.write(data)
    with (args.output / "manifest.json").open("x", encoding="utf-8") as stream:
        json.dump(manifest, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    with (args.output / "index.html").open("xb") as stream:
        stream.write(make_page(cases))
    print(json.dumps({"output": str(args.output), "cases": len(cases),
                      "formatted_prompt_tokens": [case["python_formatted_prompt_tokens"] for case, _, _ in cases],
                      "max_output_tokens": [case["max_output_tokens"] for case, _, _ in cases]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
