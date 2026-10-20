/** Compiled additions to the existing closed device-tool registry. */
export const extendedDeviceToolNames = [
  'alarm_list', 'alarm_create', 'alarm_update', 'alarm_stop', 'alarm_cancel',
  'translation_languages', 'text_translate',
  'document_scan', 'document_export_pdf', 'document_preview', 'document_read',
  'document_search', 'document_index', 'document_unindex', 'message_compose',
] as const;
export type ExtendedDeviceToolName = (typeof extendedDeviceToolNames)[number];
export const extendedToolEffects: Record<ExtendedDeviceToolName, 'read' | 'write' | 'interactive'> = {
  alarm_list: 'read', alarm_create: 'write', alarm_update: 'write', alarm_stop: 'write', alarm_cancel: 'write',
  translation_languages: 'read', text_translate: 'interactive',
  document_scan: 'interactive', document_export_pdf: 'interactive', document_preview: 'interactive',
  document_read: 'read', document_search: 'read', document_index: 'write', document_unindex: 'write', message_compose: 'interactive',
};
export const extendedToolLabels: Record<ExtendedDeviceToolName, string> = {
  alarm_list: 'Consulter les alarmes Assist', alarm_create: 'Créer une alarme ou un minuteur Assist',
  alarm_update: 'Modifier une alarme Assist', alarm_stop: 'Arrêter une alarme Assist', alarm_cancel: 'Annuler une alarme Assist',
  translation_languages: 'Vérifier les langues locales', text_translate: 'Traduire localement un texte',
  document_scan: 'Scanner un document', document_export_pdf: 'Exporter un PDF sélectionné',
  document_preview: 'Afficher un document sélectionné', document_read: 'Lire un document sélectionné',
  document_search: 'Rechercher dans les documents Assist', document_index: 'Indexer un document Assist',
  document_unindex: 'Retirer un document de l’index Assist', message_compose: 'Préparer un message dans le composeur Apple',
};
export function extendedToolEffect(name: string) {
  return Object.prototype.hasOwnProperty.call(extendedToolEffects, name)
    ? extendedToolEffects[name as ExtendedDeviceToolName] : undefined;
}
export function ownsSystemInteraction(name: string): boolean {
  return name.startsWith('alarm_') && name !== 'alarm_list';
}
/** These interactive controllers can commit outside the app before a receipt. */
export function interactiveMayCommit(name: string): boolean {
  return ['document_scan', 'document_export_pdf', 'message_compose'].includes(name);
}
