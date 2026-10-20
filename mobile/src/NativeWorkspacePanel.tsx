import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { ApplePlacesPanel } from './ApplePlacesPanel';
import { useAppearance } from './appearance';
import { scheduleAccessibilityFocus } from './focusAccessibility';
import { ActionButton, ScreenHeading, SurfaceGroup } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';
import {
  CheckpointSnapshot,
  DocumentRead,
  InboxDocument,
  parseDocumentImport,
  parseDocumentInbox,
  parseDocumentRead,
  parseDocumentRemoval,
  parseDocumentStatus,
  parseExportReceipt,
  parsePrivateSearch,
  parsePrivateServiceStatus,
  parseResearchCapabilities,
  parseResearchResult,
  ResearchResult,
  parseTaskCheckpoints,
  parseWorkspaceAcknowledgement,
  PrivateSearch,
  PrivateServiceStatus,
  TaskCheckpoint,
  workspaceBytes,
} from './nativeWorkspaceProtocol';

const requiredMethods = [
  'getPrivateServiceStatus',
  'presentPrivateServiceSetup',
  'disconnectPrivateService',
  'searchPrivateService',
  'openPrivateSearchResult',
  'getDocumentStatus',
  'importDocument',
  'getDocumentInbox',
  'readDocument',
  'removeDocument',
  'exportDocumentText',
  'getTaskCheckpoints',
  'updateTaskCheckpoint',
  'cancelNativeWorkspace',
] as const;
const kinds = {
  text: 'Texte',
  url: 'Lien partagé',
  pdf: 'PDF',
  image: 'Image',
};
const states = {
  running: 'En cours',
  paused: 'En pause',
  completed: 'Terminée',
  cancelled: 'Annulée',
  outcome_unknown: 'Vérification requise',
};

/** Correlation IDs only, never credentials, permissions or confirmation tokens. */
function newTaskId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.floor(Math.random() * 16);
    return (character === 'x' ? value : (value % 4) + 8).toString(16);
  });
}
function validQuestion(value: string) {
  return (
    !!value.trim() &&
    workspaceBytes(value.trim()) <= 512 &&
    !Array.from(value).some(
      character =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

/** Explicit native workspace, separate from Gemma and its private-data tools. */
export function NativeWorkspacePanel({
  onClose,
  blocked,
}: {
  onClose: () => void;
  blocked: boolean;
}) {
  const {
    theme: { colors },
  } = useAppearance();
  const available =
    Platform.OS === 'ios' &&
    requiredMethods.every(
      method => typeof NativeAssist?.[method] === 'function',
    );
  const mounted = useRef(false);
  const heading = useRef<React.ElementRef<typeof Text>>(null);
  const foreground = useRef(AppState.currentState === 'active');
  const epoch = useRef(0);
  const busy = useRef(false);
  const cancelling = useRef(false);
  const cancellationRequired = useRef(false);
  const lifecycleInterrupted = useRef(false);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const [active, setActive] = useState(foreground.current);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [needsCancellation, setNeedsCancellation] = useState(false);
  const [privateStatus, setPrivateStatus] =
    useState<PrivateServiceStatus | null>(null);
  const [documentsAvailable, setDocumentsAvailable] = useState(false);
  const [inbox, setInbox] = useState<InboxDocument[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointSnapshot | null>(
    null,
  );
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<PrivateSearch | null>(null);
  const [research, setResearch] = useState<ResearchResult | null>(null);
  const researchAvailable =
    typeof NativeAssist?.getResearchCapabilities === 'function' &&
    typeof NativeAssist?.generateResearch === 'function';
  const [document, setDocument] = useState<DocumentRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function isCurrent(ticket: number) {
    return (
      mounted.current &&
      foreground.current &&
      epoch.current === ticket &&
      !blockedRef.current
    );
  }
  function invalidateEpoch() {
    epoch.current += 1;
  }
  useEffect(() => scheduleAccessibilityFocus(() => heading.current), []);
  async function readMetadata(current: () => boolean) {
    const [serviceJSON, documentsJSON, checkpointJSON] = await Promise.all([
      NativeAssist!.getPrivateServiceStatus(),
      NativeAssist!.getDocumentStatus(),
      NativeAssist!.getTaskCheckpoints(),
    ]);
    if (!current()) return;
    const service = parsePrivateServiceStatus(serviceJSON);
    const docs = parseDocumentStatus(documentsJSON);
    const tasks = parseTaskCheckpoints(checkpointJSON);
    const items = docs.available
      ? parseDocumentInbox(await NativeAssist!.getDocumentInbox())
      : [];
    if (!current()) return;
    setPrivateStatus(service);
    setDocumentsAvailable(docs.available);
    setCheckpoints(tasks);
    setInbox(items);
  }
  async function run(
    label: string,
    action: (current: () => boolean) => Promise<void>,
  ) {
    if (
      !available ||
      busy.current ||
      cancellationRequired.current ||
      blockedRef.current ||
      !foreground.current
    )
      return;
    busy.current = true;
    const ticket = ++epoch.current;
    const current = () => isCurrent(ticket);
    setBusyLabel(label);
    setError(null);
    setNotice(null);
    try {
      await action(current);
    } catch {
      if (current()) {
        setSearch(null);
        setResearch(null);
        setDocument(null);
        setCheckpoints(null);
        setPrivateStatus(null);
        setError(
          'Opération non confirmée ou contrat incompatible. Aucun résultat tardif ni reprise automatique accepté. Actualise avant de continuer.',
        );
        try {
          parseWorkspaceAcknowledgement(
            await NativeAssist!.cancelNativeWorkspace(),
            'cancelled',
          );
          const tasks = parseTaskCheckpoints(
            await NativeAssist!.getTaskCheckpoints(),
          );
          if (current()) setCheckpoints(tasks);
        } catch {
          /* Keep recovery disabled; never replace an unreadable journal. */
        }
      }
    } finally {
      if (epoch.current === ticket && mounted.current) {
        busy.current = false;
        setBusyLabel(null);
      }
    }
  }
  async function cancel(interrupted = false) {
    if (!available || cancelling.current) return;
    cancelling.current = true;
    cancellationRequired.current = true;
    setNeedsCancellation(true);
    busy.current = true;
    // Fence old callbacks synchronously, even if iOS is only briefly inactive.
    const ticket = ++epoch.current;
    setBusyLabel('Annulation…');
    setQuery('');
    setSearch(null);
    setResearch(null);
    setDocument(null);
    setCheckpoints(null);
    setNotice(null);
    setError(null);
    try {
      parseWorkspaceAcknowledgement(
        await NativeAssist!.cancelNativeWorkspace(),
        'cancelled',
      );
      if (epoch.current !== ticket || !mounted.current) return;
      cancellationRequired.current = false;
      setNeedsCancellation(false);
      const tasks = parseTaskCheckpoints(
        await NativeAssist!.getTaskCheckpoints(),
      );
      if (isCurrent(ticket)) {
        // An active event may have arrived while cancellation was pending.
        // Reload metadata only; never resume the interrupted native operation.
        if (interrupted) await readMetadata(() => isCurrent(ticket));
        if (!isCurrent(ticket)) return;
        setCheckpoints(tasks);
        setNotice(
          'Travail interrompu. Une reprise exige un nouveau choix explicite.',
        );
      }
    } catch {
      if (epoch.current === ticket && mounted.current) {
        setCheckpoints(null);
        setError(
          'Annulation ou checkpoint non confirmé. Ne relance pas automatiquement.',
        );
      }
    } finally {
      cancelling.current = false;
      if (epoch.current === ticket && mounted.current) {
        busy.current = false;
        setBusyLabel(null);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (available) run('Actualisation…', readMetadata).catch(() => undefined);
    const listener = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      setActive(foreground.current);
      if (state !== 'active') {
        if (!lifecycleInterrupted.current) {
          lifecycleInterrupted.current = true;
          cancel(true).catch(() => undefined);
        }
      } else {
        lifecycleInterrupted.current = false;
        if (available && !busy.current && !cancellationRequired.current)
          run('Actualisation…', readMetadata).catch(() => undefined);
      }
    });
    return () => {
      mounted.current = false;
      invalidateEpoch();
      listener.remove();
      if (available)
        NativeAssist!.cancelNativeWorkspace().catch(() => undefined);
    };
    // The native bridge is fixed for this mount. Mutable lifecycle/latches use refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);
  useEffect(() => {
    if (blocked && busy.current) cancel().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);

  async function begin(
    kind: TaskCheckpoint['kind'],
    previous?: TaskCheckpoint,
  ) {
    const taskId = previous?.taskId ?? newTaskId();
    const result = parseTaskCheckpoints(
      await NativeAssist!.updateTaskCheckpoint(
        JSON.stringify({
          schemaVersion: 1,
          action: previous ? 'resume' : 'start',
          taskId,
          expectedRevision: previous?.revision ?? 0,
          ...(previous ? {} : { kind }),
        }),
      ),
    );
    const task = result.tasks.find(entry => entry.taskId === taskId);
    if (
      !task ||
      task.kind !== kind ||
      task.state !== 'running' ||
      task.revision !== (previous ? previous.revision + 1 : 1) ||
      task.epoch !== (previous ? previous.epoch + 1 : 1)
    )
      throw new Error('Task identity mismatch');
    return task;
  }
  async function complete(task: TaskCheckpoint) {
    const result = parseTaskCheckpoints(
      await NativeAssist!.updateTaskCheckpoint(
        JSON.stringify({
          schemaVersion: 1,
          action: 'complete',
          taskId: task.taskId,
          expectedRevision: task.revision,
        }),
      ),
    );
    const completed = result.tasks.find(entry => entry.taskId === task.taskId);
    if (
      !completed ||
      completed.kind !== task.kind ||
      completed.state !== 'completed' ||
      completed.revision !== task.revision + 1 ||
      completed.epoch !== task.epoch
    )
      throw new Error('Stale completion');
    return result;
  }
  function searchQuestion(previous?: TaskCheckpoint, useGemma = false) {
    const question = query.trim();
    if (
      !validQuestion(question) ||
      !privateStatus?.configured ||
      !checkpoints ||
      (previous &&
        (previous.state !== 'paused' || previous.kind !== 'research'))
    )
      return;
    return run(
      previous
        ? 'Reprise explicite…'
        : useGemma
        ? 'Recherche avec Gemma…'
        : 'Recherche…',
      async current => {
        setQuery('');
        setSearch(null);
        setResearch(null);
        setDocument(null);
        const task = await begin('research', previous);
        if (!current()) return;
        const requestId = newTaskId();
        if (useGemma) {
          if (!researchAvailable)
            throw new Error('Research profile unavailable');
          parseResearchCapabilities(
            await NativeAssist!.getResearchCapabilities(),
          );
          if (!current()) return;
          const result = parseResearchResult(
            await NativeAssist!.generateResearch(
              JSON.stringify({
                schemaVersion: 1,
                requestId,
                messages: [{ role: 'user', content: question }],
                temperature: 0,
                maxTokens: 1024,
              }),
            ),
            requestId,
          );
          if (!current()) return;
          const tasks = await complete(task);
          if (current()) {
            setResearch(result);
            setCheckpoints(tasks);
          }
          return;
        }
        const result = parsePrivateSearch(
          await NativeAssist!.searchPrivateService(
            JSON.stringify({
              schemaVersion: 1,
              requestId,
              query: question,
            }),
          ),
          requestId,
        );
        if (!current()) return;
        const tasks = await complete(task);
        if (current()) {
          setSearch(result);
          setCheckpoints(tasks);
          setNotice(
            'Résultats de recherche reçus; les pages n’ont pas été lues.',
          );
        }
      },
    );
  }
  function read(item: InboxDocument) {
    return run('Lecture locale…', async current => {
      setDocument(null);
      setSearch(null);
      setResearch(null);
      const task = await begin('document');
      if (!current()) return;
      const result = parseDocumentRead(
        await NativeAssist!.readDocument(item.id),
        item,
      );
      if (!current()) return;
      const tasks = await complete(task);
      if (!current()) return;
      const items = parseDocumentInbox(await NativeAssist!.getDocumentInbox());
      if (current()) {
        setDocument(result);
        setCheckpoints(tasks);
        setInbox(items);
      }
    });
  }
  function abandon(task: TaskCheckpoint) {
    if (task.state !== 'paused') return;
    return run('Abandon de la tâche…', async current => {
      const result = parseTaskCheckpoints(
        await NativeAssist!.updateTaskCheckpoint(
          JSON.stringify({
            schemaVersion: 1,
            action: 'cancel',
            taskId: task.taskId,
            expectedRevision: task.revision,
          }),
        ),
      );
      const cancelled = result.tasks.find(
        entry => entry.taskId === task.taskId,
      );
      if (
        !cancelled ||
        cancelled.kind !== task.kind ||
        cancelled.state !== 'cancelled' ||
        cancelled.revision !== task.revision + 1 ||
        cancelled.epoch !== task.epoch
      )
        throw new Error('Abandon unconfirmed');
      if (current()) {
        setCheckpoints(result);
        setNotice('Tâche abandonnée. Aucun travail n’a été relancé.');
      }
    });
  }
  const disabled =
    !available || blocked || !active || !!busyLabel || needsCancellation;
  const checkpointRunning = checkpoints?.tasks.some(
    task => task.state === 'running',
  );
  const canResearch =
    !disabled &&
    !checkpointRunning &&
    privateStatus?.configured &&
    checkpoints &&
    validQuestion(query);
  const copyStyle = [styles.copy, { color: colors.text }];
  return (
    <View style={styles.panel}>
      <ScreenHeading
        title="Recherche et documents"
        headingRef={heading}
        description="Contrôles natifs explicites. Aucun contenu privé n’est envoyé à Gemma ou à la recherche automatiquement."
      />
      <ActionButton label="Retour aux réglages" onPress={onClose} />
      {!available && (
        <Text role="alert" style={copyStyle}>
          Ce socle natif est absent de cette build. Aucun accès lancé.
        </Text>
      )}
      {blocked && (
        <Text style={copyStyle}>Attends la fin de l’opération en cours.</Text>
      )}
      {busyLabel && (
        <Text role="status" style={copyStyle}>
          {busyLabel}
        </Text>
      )}
      {error && (
        <Text role="alert" style={[styles.copy, { color: colors.danger }]}>
          {error}
        </Text>
      )}
      {notice && (
        <Text role="status" style={copyStyle}>
          {notice}
        </Text>
      )}
      <ActionButton
        label="Actualiser le statut"
        disabled={disabled}
        onPress={() => run('Actualisation…', readMetadata)}
      />
      <ActionButton
        label="Interrompre le travail"
        disabled={
          !available ||
          cancelling.current ||
          (!busyLabel && !needsCancellation && !checkpointRunning)
        }
        onPress={() => cancel()}
      />
      <SurfaceGroup title="Service privé Ubuntu">
        <View style={styles.section}>
          <Text style={copyStyle}>
            {privateStatus?.configured
              ? `Configuré : ${privateStatus.origin}`
              : privateStatus?.state === 'disconnect_failed'
              ? 'Accès bloqué; suppression du trousseau à vérifier.'
              : 'Non configuré'}
          </Text>
          <Text style={[styles.caption, { color: colors.muted }]}>
            Le secret est saisi uniquement dans l’interface native et conservé
            dans le trousseau.
          </Text>
          <ActionButton
            label="Configurer le service privé"
            disabled={disabled}
            onPress={() =>
              run('Configuration native…', async current => {
                const status = parsePrivateServiceStatus(
                  await NativeAssist!.presentPrivateServiceSetup(),
                );
                if (current()) {
                  setPrivateStatus(status);
                  setSearch(null);
                  setResearch(null);
                  setQuery('');
                }
              })
            }
          />
          <ActionButton
            label="Déconnecter le service privé"
            disabled={
              disabled ||
              !privateStatus ||
              privateStatus.state === 'not_configured'
            }
            onPress={() =>
              run('Déconnexion…', async current => {
                const status = parsePrivateServiceStatus(
                  await NativeAssist!.disconnectPrivateService(),
                );
                if (status.configured)
                  throw new Error('Disconnect unconfirmed');
                if (current()) {
                  setPrivateStatus(status);
                  setSearch(null);
                  setResearch(null);
                  setQuery('');
                }
              })
            }
          />
          <TextInput
            accessibilityLabel="Nouvelle question de recherche"
            value={query}
            onChangeText={setQuery}
            editable={!disabled}
            maxLength={512}
            placeholder="Question publique, sans données privées"
            placeholderTextColor={colors.placeholder}
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.border },
            ]}
          />
          <Text style={[styles.caption, { color: colors.muted }]}>
            512 octets maximum. Question conservée en mémoire seulement; aucun
            historique n’est restauré.
          </Text>
          <ActionButton
            label="Rechercher sur Ubuntu"
            primary
            disabled={!canResearch}
            onPress={() => searchQuestion()}
          />
          <Text style={[styles.caption, { color: colors.muted }]}>
            Avec Gemma : cette question publique est envoyée aux moteurs;
            jusqu’à quatre pages peuvent être lues par Ubuntu. La synthèse reste
            locale. Aucun historique, contact ou document n’est joint.
          </Text>
          <ActionButton
            label="Rechercher avec Gemma"
            disabled={!canResearch || !researchAvailable}
            onPress={() => searchQuestion(undefined, true)}
          />
          {research && (
            <View style={styles.item}>
              <Text selectable style={copyStyle}>
                {research.text}
              </Text>
              {research.degraded && (
                <Text role="status" style={copyStyle}>
                  Résultats dégradés ou plafonnés; couverture non exhaustive.
                </Text>
              )}
              {research.sources.length === 0 && (
                <Text style={copyStyle}>Aucune page lue confirmée.</Text>
              )}
              {research.sources.map((source, index) => (
                <View key={source.id} style={styles.item}>
                  <Text style={copyStyle}>
                    Page lue : {source.title}
                    {source.truncated ? ' · extrait tronqué' : ''}
                  </Text>
                  <Text style={[styles.caption, { color: colors.muted }]}>
                    {source.url} · {source.readAt}
                  </Text>
                  <ActionButton
                    label={`Ouvrir la page lue ${index + 1}`}
                    disabled={disabled}
                    onPress={() =>
                      run('Ouverture de Safari…', async () =>
                        parseWorkspaceAcknowledgement(
                          await NativeAssist!.openPrivateSearchResult(
                            research.requestId,
                            source.id,
                          ),
                          'opened',
                        ),
                      )
                    }
                  />
                </View>
              ))}
            </View>
          )}
          {search?.degraded && (
            <Text role="status" style={copyStyle}>
              Recherche dégradée : certains moteurs sont indisponibles.
            </Text>
          )}
          {search && search.results.length === 0 && (
            <Text style={copyStyle}>Aucun résultat reçu.</Text>
          )}
          {search?.results.map((hit, index) => (
            <View key={hit.id} style={styles.item}>
              <Text style={copyStyle}>{hit.title || 'Source sans titre'}</Text>
              <Text style={[styles.caption, { color: colors.muted }]}>
                {hit.url}
              </Text>
              <Text style={copyStyle}>{hit.snippet}</Text>
              <ActionButton
                label={`Ouvrir la source ${index + 1}`}
                disabled={disabled}
                onPress={() =>
                  run('Ouverture de Safari…', async current => {
                    parseWorkspaceAcknowledgement(
                      await NativeAssist!.openPrivateSearchResult(
                        search.requestId,
                        hit.id,
                      ),
                      'opened',
                    );
                    if (current())
                      setNotice(
                        'Source présentée dans Safari; son contenu n’est pas transmis à Gemma.',
                      );
                  })
                }
              />
            </View>
          ))}
        </View>
      </SurfaceGroup>
      <ApplePlacesPanel blocked={disabled} />
      <SurfaceGroup title="Documents sélectionnés">
        <View style={styles.section}>
          <Text style={copyStyle}>
            Boîte privée d’Assist uniquement, jamais l’ensemble de Fichiers.
            Texte/OCR non fiable et potentiellement tronqué.
          </Text>
          <ActionButton
            label="Importer un document"
            disabled={disabled || !documentsAvailable}
            onPress={() =>
              run('Sélection du document…', async current => {
                const item = parseDocumentImport(
                  await NativeAssist!.importDocument(),
                );
                if (!current()) return;
                if (!item) {
                  setNotice('Import annulé.');
                  return;
                }
                const items = parseDocumentInbox(
                  await NativeAssist!.getDocumentInbox(),
                );
                if (!items.some(entry => entry.id === item.id))
                  throw new Error('Missing imported document');
                if (current()) {
                  setInbox(items);
                  setNotice('Document importé, pas encore lu.');
                }
              })
            }
          />
          {inbox.map((item, index) => (
            <View key={item.id} style={styles.item}>
              <Text style={copyStyle}>
                {kinds[item.kind]} · {item.byteCount} octets ·{' '}
                {item.source === 'share' ? 'Partage' : 'Sélection'}
              </Text>
              <ActionButton
                label={`Lire le document ${index + 1}`}
                disabled={disabled || !checkpoints || checkpointRunning}
                onPress={() => read(item)}
              />
              <ActionButton
                label={`Retirer le document ${index + 1}`}
                disabled={disabled}
                destructive
                onPress={() =>
                  run('Retrait de la copie Assist…', async current => {
                    if (
                      !parseDocumentRemoval(
                        await NativeAssist!.removeDocument(item.id),
                        item.id,
                      )
                    )
                      throw new Error('Removal unconfirmed');
                    if (current()) {
                      setInbox(previous =>
                        previous.filter(entry => entry.id !== item.id),
                      );
                      if (document?.id === item.id) setDocument(null);
                    }
                  })
                }
              />
            </View>
          ))}
          {document && (
            <View style={styles.item}>
              <Text role="heading" style={copyStyle}>
                Texte extrait — donnée non fiable
                {document.truncated ? ' · tronqué' : ''}
              </Text>
              <Text selectable style={copyStyle}>
                {document.text || 'Aucun texte extrait.'}
              </Text>
              <ActionButton
                label="Exporter le texte affiché"
                disabled={disabled || !document.text.trim()}
                onPress={() =>
                  run('Export du texte…', async current => {
                    const status = parseExportReceipt(
                      await NativeAssist!.exportDocumentText(
                        JSON.stringify({
                          filename: 'assist-document.txt',
                          text: document.text,
                        }),
                      ),
                    );
                    if (current())
                      setNotice(
                        status === 'exported'
                          ? 'Export confirmé par le sélecteur.'
                          : 'Export annulé.',
                      );
                  })
                }
              />
            </View>
          )}
        </View>
      </SurfaceGroup>
      <SurfaceGroup title="Tâches et reprise explicite">
        <View style={styles.section}>
          {!checkpoints && (
            <Text style={copyStyle}>
              Checkpoint indisponible : aucune reprise autorisée.
            </Text>
          )}
          {checkpoints?.tasks.map((task, index) => (
            <View key={task.taskId} style={styles.item}>
              <Text style={copyStyle}>
                Tâche {index + 1} ·{' '}
                {task.kind === 'research' ? 'Recherche' : 'Document'} ·{' '}
                {states[task.state]}
                {task.pauseReason === 'interrupted'
                  ? ' après interruption'
                  : ''}
              </Text>
              {task.state === 'outcome_unknown' && (
                <Text
                  role="alert"
                  style={[styles.copy, { color: colors.danger }]}
                >
                  Résultat incertain. Vérifie avant toute nouvelle action;
                  aucune reprise disponible.
                </Text>
              )}
              {task.kind === 'research' && task.state === 'paused' && (
                <ActionButton
                  label={`Reprendre la recherche ${
                    index + 1
                  } avec une nouvelle question`}
                  disabled={!canResearch}
                  onPress={() => searchQuestion(task)}
                />
              )}
              {task.state === 'paused' && (
                <ActionButton
                  label={`Abandonner la tâche ${index + 1}`}
                  disabled={disabled}
                  onPress={() => abandon(task)}
                />
              )}
            </View>
          ))}
          <Text style={[styles.caption, { color: colors.muted }]}>
            Le checkpoint ne contient que des identifiants et des états. Aucun
            prompt, URL, document ou secret; aucune écriture n’est rejouée.
          </Text>
        </View>
      </SurfaceGroup>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: uiGrammar.harmony.space.large },
  section: {
    padding: uiGrammar.harmony.space.large,
    gap: uiGrammar.harmony.space.medium,
  },
  item: {
    gap: uiGrammar.harmony.space.small,
    paddingVertical: uiGrammar.harmony.space.small,
  },
  copy: { ...uiGrammar.type.body },
  caption: { ...uiGrammar.type.caption },
  input: {
    ...uiGrammar.type.body,
    borderWidth: 1,
    borderRadius: uiGrammar.radius.control,
    minHeight: uiGrammar.touchTarget,
    padding: uiGrammar.harmony.space.medium,
  },
});
