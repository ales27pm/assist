import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { useAppearance } from './appearance';
import { scheduleAccessibilityFocus } from './focusAccessibility';
import { ActionButton, ScreenHeading, SurfaceGroup } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';
import { InboxDocument, parseDocumentInbox } from './nativeWorkspaceProtocol';
import {
  DocumentAction,
  DocumentActionRequest,
  DocumentActionResult,
  documentActionReceipt,
  makeDocumentActionRequest,
  parseDocumentActionResult,
} from './documentActionsProtocol';

type Bridge = {
  getDocumentInbox(): Promise<string>;
  executeDocumentAction(json: string): Promise<string>;
  cancelDocumentActions(): Promise<string>;
};
const native = NativeAssist as Partial<Bridge> | null;

/** User-invoked actions share native validation with Gemma; no auto-send or
 * indexing on import. An OS permission does not confirm a metadata mutation. */
export function DocumentActionsPanel({
  onClose,
  blocked,
}: {
  onClose: () => void;
  blocked: boolean;
}) {
  const {
    theme: { colors },
  } = useAppearance();
  const supported =
    Platform.OS === 'ios' &&
    [
      'getDocumentInbox',
      'executeDocumentAction',
      'cancelDocumentActions',
    ].every(key => typeof native?.[key as keyof Bridge] === 'function');
  const [items, setItems] = useState<InboxDocument[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<DocumentActionResult | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [filename, setFilename] = useState('assist-document.pdf');
  const [title, setTitle] = useState('Document Assist');
  const [query, setQuery] = useState('');
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [recipients, setRecipients] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attach, setAttach] = useState(false);
  const heading = useRef<React.ComponentRef<typeof Text>>(null);
  const mounted = useRef(false);
  const foreground = useRef(active);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const busy = useRef(false);
  const epoch = useRef(0);
  const ticket = useRef<object | null>(null);
  const cancelling = useRef(false);
  const cancellationRequired = useRef(false);
  const disabled = !supported || blocked || !active || pending || confirming;

  const cancel = () => {
    ticket.current = null;
    epoch.current += 1;
    if (mounted.current) {
      setConfirming(false);
      setResult(null);
    }
    if ((!busy.current && !cancellationRequired.current) || cancelling.current)
      return;
    cancelling.current = true;
    cancellationRequired.current = true;
    native
      ?.cancelDocumentActions?.()
      .then(() => {
        cancellationRequired.current = false;
        if (mounted.current)
          setNotice(
            'Arrêt demandé. Vérifie Spotlight ou le composeur si une action avait déjà été soumise.',
          );
      })
      .catch(() => {
        if (mounted.current)
          setError(
            'Arrêt non confirmé. Ferme cette opération avant de recommencer.',
          );
      })
      .finally(() => {
        cancelling.current = false;
        busy.current = false;
        if (mounted.current) setPending(cancellationRequired.current);
      });
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    mounted.current = true;
    const focus = scheduleAccessibilityFocus(() => heading.current);
    const lifecycle = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      setActive(foreground.current);
      if (!foreground.current) cancelRef.current();
    });
    return () => {
      mounted.current = false;
      focus();
      lifecycle.remove();
      cancelRef.current();
    };
  }, []);
  useEffect(() => {
    if (blocked) cancelRef.current();
  }, [blocked]);

  function available() {
    return (
      supported &&
      mounted.current &&
      foreground.current &&
      !blockedRef.current &&
      !busy.current &&
      !ticket.current &&
      !cancellationRequired.current
    );
  }
  async function run(operation: (current: () => boolean) => Promise<void>) {
    if (!available()) return;
    busy.current = true;
    const currentEpoch = ++epoch.current;
    setPending(true);
    setError('');
    setNotice('');
    setResult(null);
    const current = () =>
      mounted.current &&
      epoch.current === currentEpoch &&
      foreground.current &&
      !blockedRef.current;
    try {
      await operation(current);
    } catch (failure) {
      if (current())
        setError(
          failure instanceof Error
            ? failure.message
            : 'L’opération n’a pas fourni de reçu utilisable.',
        );
    } finally {
      if (epoch.current === currentEpoch) {
        busy.current = false;
        if (mounted.current) setPending(false);
      }
    }
  }
  function refresh() {
    return run(async current => {
      const next = parseDocumentInbox(await native!.getDocumentInbox!());
      if (!current()) return;
      setItems(next);
      setSelected(previous =>
        next.some(item => item.id === previous) ? previous : null,
      );
    });
  }
  function execute(request: DocumentActionRequest) {
    return run(async current => {
      const response = parseDocumentActionResult(
        await native!.executeDocumentAction!(JSON.stringify(request)),
        request,
      );
      if (!current()) return;
      setResult(response);
      setNotice(documentActionReceipt(response));
      if (response.status === 'scanned' && response.inboxId) {
        const next = parseDocumentInbox(await native!.getDocumentInbox!());
        if (current()) {
          setItems(next);
          setSelected(response.inboxId);
        }
      }
    });
  }
  function action(
    action_: DocumentAction,
    arguments_: Record<string, unknown>,
    confirmation?: string,
  ) {
    if (!available()) return;
    try {
      // Freeze the exact normalized request before showing the user its preview.
      const request = makeDocumentActionRequest(action_, arguments_);
      if (!confirmation) {
        execute(request);
        return;
      }
      const identity = {};
      const expires = Date.now() + 60_000;
      ticket.current = identity;
      setConfirming(true);
      const dismiss = () => {
        if (ticket.current !== identity) return;
        ticket.current = null;
        if (mounted.current) setConfirming(false);
      };
      Alert.alert(
        confirmation,
        Object.entries(arguments_)
          .map(
            ([key, value]) =>
              `${key} : ${
                Array.isArray(value) ? value.join(', ') : String(value)
              }`,
          )
          .join('\n'),
        [
          { text: 'Annuler', style: 'cancel', onPress: dismiss },
          {
            text: 'Confirmer',
            onPress: () => {
              if (ticket.current !== identity) return;
              dismiss();
              if (Date.now() <= expires && available()) execute(request);
            },
          },
        ],
        { cancelable: true, onDismiss: dismiss },
      );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Paramètres invalides.',
      );
    }
  }
  const input = [
    styles.input,
    { color: colors.text, borderColor: colors.border },
  ];
  const copy = [styles.copy, { color: colors.text }];
  const muted = [styles.caption, { color: colors.muted }];
  return (
    <View style={styles.body}>
      <ScreenHeading
        title="Documents et composition"
        headingRef={heading}
        description="Documents choisis dans Assist, sans accès général à Fichiers ou aux boîtes de messages."
      />
      <ActionButton
        label="Retour aux réglages"
        onPress={() => {
          cancel();
          onClose();
        }}
      />
      {!supported && (
        <Text style={muted}>
          Ces actions demandent le binaire natif compatible.
        </Text>
      )}
      <SurfaceGroup title="Scanner et documents choisis">
        <View style={styles.group}>
          <Text style={muted}>
            Scan de 8 pages maximum. OCR Apple borné à 40 lignes et 8 Kio. Aucun
            texte protégé n’est déverrouillé.
          </Text>
          <ActionButton
            label="Scanner un document"
            disabled={disabled}
            onPress={() => action('scan', { maxPages: 8 })}
          />
          <ActionButton
            label="Actualiser les documents Assist"
            disabled={disabled}
            onPress={refresh}
          />
          {items.map((item, index) => (
            <ActionButton
              key={item.id}
              label={`Choisir le document ${index + 1}${
                selected === item.id ? ' · choisi' : ''
              }`}
              disabled={disabled}
              onPress={() => {
                setSelected(item.id);
                setResult(null);
              }}
            />
          ))}
          <ActionButton
            label="Lire le document choisi"
            disabled={disabled || !selected}
            onPress={() => action('read', { inboxId: selected })}
          />
          <ActionButton
            label="Aperçu du document choisi"
            disabled={disabled || !selected}
            onPress={() => action('preview', { inboxId: selected })}
          />
          <TextInput
            accessibilityLabel="Nom du PDF exporté"
            value={filename}
            onChangeText={setFilename}
            editable={!disabled}
            maxLength={64}
            style={input}
          />
          <ActionButton
            label="Exporter le document choisi en PDF"
            disabled={disabled || !selected}
            onPress={() =>
              action('export_pdf', { inboxId: selected, filename })
            }
          />
        </View>
      </SurfaceGroup>
      <SurfaceGroup title="Recherche locale explicite">
        <View style={styles.group}>
          <Text style={muted}>
            Seuls les documents que tu choisis sont indexés dans Spotlight sur
            cet appareil, avec expiration. Aucun index privé d’autres apps n’est
            lu.
          </Text>
          <TextInput
            accessibilityLabel="Titre du document dans Spotlight"
            value={title}
            onChangeText={setTitle}
            editable={!disabled}
            maxLength={120}
            style={input}
          />
          <ActionButton
            label="Indexer le document choisi pour 1 jour"
            disabled={disabled || !selected}
            onPress={() =>
              action(
                'index',
                { inboxId: selected, title, expirationDays: 1 },
                'Indexer ce titre et le texte extrait dans Spotlight ?',
              )
            }
          />
          <ActionButton
            label="Retirer le document choisi de Spotlight"
            disabled={disabled || !selected}
            onPress={() =>
              action(
                'unindex',
                { inboxId: selected },
                'Retirer ce document de Spotlight ?',
              )
            }
          />
          <TextInput
            accessibilityLabel="Recherche dans les documents indexés"
            value={query}
            onChangeText={setQuery}
            editable={!disabled}
            maxLength={128}
            style={input}
          />
          <ActionButton
            label="Rechercher les documents choisis"
            disabled={disabled || !query.trim()}
            onPress={() => action('search', { query, limit: 10 })}
          />
          {result?.results?.map(hit => (
            <View key={hit.inboxId} style={styles.group}>
              <Text style={copy}>{hit.title}</Text>
              <ActionButton
                label={`Ouvrir : ${hit.title}`}
                disabled={disabled}
                onPress={() => action('preview', { inboxId: hit.inboxId })}
              />
            </View>
          ))}
        </View>
      </SurfaceGroup>
      <SurfaceGroup title="Composer dans l’interface Apple">
        <View style={styles.group}>
          <Text style={muted}>
            Relis les destinataires, le texte et la pièce jointe. Tu décides de
            l’envoi dans Mail ou Messages. Le reçu ne prouve ni livraison ni
            lecture.
          </Text>
          <ActionButton
            label={`Courriel${channel === 'email' ? ' · choisi' : ''}`}
            disabled={disabled}
            onPress={() => setChannel('email')}
          />
          <ActionButton
            label={`SMS${channel === 'sms' ? ' · choisi' : ''}`}
            disabled={disabled}
            onPress={() => {
              setChannel('sms');
              setSubject('');
            }}
          />
          <TextInput
            accessibilityLabel="Destinataires séparés par des virgules"
            value={recipients}
            onChangeText={setRecipients}
            editable={!disabled}
            autoCapitalize="none"
            maxLength={2550}
            style={input}
          />
          {channel === 'email' && (
            <TextInput
              accessibilityLabel="Objet du courriel"
              value={subject}
              onChangeText={setSubject}
              editable={!disabled}
              maxLength={256}
              style={input}
            />
          )}
          <TextInput
            accessibilityLabel="Texte du message"
            value={body}
            onChangeText={setBody}
            editable={!disabled}
            maxLength={8192}
            multiline
            style={input}
          />
          <ActionButton
            label={`Joindre le document choisi${attach ? ' · oui' : ' · non'}`}
            disabled={disabled || !selected}
            onPress={() => setAttach(value => !value)}
          />
          <ActionButton
            label="Revoir puis ouvrir le composeur Apple"
            disabled={disabled || !recipients.trim() || (attach && !selected)}
            onPress={() =>
              action(
                'compose',
                {
                  channel,
                  recipients: recipients.split(',').map(value => value.trim()),
                  subject: channel === 'email' ? subject : '',
                  body,
                  ...(attach && selected ? { attachmentId: selected } : {}),
                },
                'Préparer cette composition exacte dans Apple ?',
              )
            }
          />
        </View>
      </SurfaceGroup>
      <ActionButton
        label="Interrompre les actions de document"
        disabled={!pending}
        onPress={cancel}
      />
      {pending && (
        <Text role="status" style={copy}>
          Opération en cours…
        </Text>
      )}
      {!!notice && (
        <Text role="status" style={copy}>
          {notice}
        </Text>
      )}
      {!!error && (
        <Text role="alert" style={[styles.copy, { color: colors.danger }]}>
          {error}
        </Text>
      )}
      {!!result?.text && (
        <Text selectable style={copy}>
          {result.text}
          {result.truncated ? '\nTexte limité.' : ''}
        </Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  body: { gap: uiGrammar.harmony.space.large },
  group: {
    padding: uiGrammar.harmony.space.large,
    gap: uiGrammar.harmony.space.medium,
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
