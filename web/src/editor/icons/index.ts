// Icons (P5.5): the catalog of the four icon fonts, `:` autocomplete and insertIcon.
export * from './catalog';
export { IconSuggestion, insertIcon } from './extension';
export {
  acceptSuggestion,
  dismissSuggestion,
  iconNode,
  iconSuggestionKey,
  iconSuggestionPlugin,
  insertIconAt,
  MIN_QUERY,
  moveSuggestion,
  SUGGESTION_LIMIT,
  suggestionIds,
  triggerBefore,
  type IconSuggestionState,
} from './suggestion';
