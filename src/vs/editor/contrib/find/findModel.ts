/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { findFirstInSorted } from 'vs/base/common/arrays';
import { RunOnceScheduler, TimeoutTimer } from 'vs/base/common/async';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { DisposableStore, dispose } from 'vs/base/common/lifecycle';
import { Constants } from 'vs/base/common/uint';
import { IActiveCodeEditor } from 'vs/editor/browser/editorBrowser';
import { ReplaceCommand, ReplaceCommandThatPreservesSelection } from 'vs/editor/common/commands/replaceCommand';
import { EditorOption } from 'vs/editor/common/config/editorOptions';
import { CursorChangeReason, ICursorPositionChangedEvent } from 'vs/editor/common/controller/cursorEvents';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';
import { ICommand, ScrollType } from 'vs/editor/common/editorCommon';
import { EndOfLinePreference, FindMatch, ITextModel } from 'vs/editor/common/model';
import { SearchParams } from 'vs/editor/common/model/textModelSearch';
import { FindDecorations } from 'vs/editor/contrib/find/findDecorations';
import { FindReplaceState, FindReplaceStateChangedEvent } from 'vs/editor/contrib/find/findState';
import { ReplaceAllCommand } from 'vs/editor/contrib/find/replaceAllCommand';
// 変更開始
import { SwapAllCommand } from 'vs/editor/contrib/find/swapAllCommand';
// 変更終了
import { parseReplaceString, ReplacePattern } from 'vs/editor/contrib/find/replacePattern';
import { RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IKeybindings } from 'vs/platform/keybinding/common/keybindingsRegistry';

export const CONTEXT_FIND_WIDGET_VISIBLE = new RawContextKey<boolean>('findWidgetVisible', false);
export const CONTEXT_FIND_WIDGET_NOT_VISIBLE = CONTEXT_FIND_WIDGET_VISIBLE.toNegated();
// Keep ContextKey use of 'Focussed' to not break when clauses
export const CONTEXT_FIND_INPUT_FOCUSED = new RawContextKey<boolean>('findInputFocussed', false);
export const CONTEXT_REPLACE_INPUT_FOCUSED = new RawContextKey<boolean>('replaceInputFocussed', false);
//変更開始
export const CONTEXT_SWAP_INPUT_FOCUSED = new RawContextKey<boolean>('swapInputFocussed', false);
//変更終了

export const ToggleCaseSensitiveKeybinding: IKeybindings = {
	primary: KeyMod.Alt | KeyCode.KEY_C,
	mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KEY_C }
};
export const ToggleWholeWordKeybinding: IKeybindings = {
	primary: KeyMod.Alt | KeyCode.KEY_W,
	mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KEY_W }
};
export const ToggleRegexKeybinding: IKeybindings = {
	primary: KeyMod.Alt | KeyCode.KEY_R,
	mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KEY_R }
};
export const ToggleSearchScopeKeybinding: IKeybindings = {
	primary: KeyMod.Alt | KeyCode.KEY_L,
	mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KEY_L }
};
export const TogglePreserveCaseKeybinding: IKeybindings = {
	primary: KeyMod.Alt | KeyCode.KEY_P,
	mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KEY_P }
};

export const FIND_IDS = {
	StartFindAction: 'actions.find',
	StartFindWithSelection: 'actions.findWithSelection',
	NextMatchFindAction: 'editor.action.nextMatchFindAction',
	PreviousMatchFindAction: 'editor.action.previousMatchFindAction',
	NextSelectionMatchFindAction: 'editor.action.nextSelectionMatchFindAction',
	PreviousSelectionMatchFindAction: 'editor.action.previousSelectionMatchFindAction',
	StartFindReplaceAction: 'editor.action.startFindReplaceAction',
	CloseFindWidgetCommand: 'closeFindWidget',
	ToggleCaseSensitiveCommand: 'toggleFindCaseSensitive',
	ToggleWholeWordCommand: 'toggleFindWholeWord',
	ToggleRegexCommand: 'toggleFindRegex',
	ToggleSearchScopeCommand: 'toggleFindInSelection',
	TogglePreserveCaseCommand: 'togglePreserveCase',
	ReplaceOneAction: 'editor.action.replaceOne',
	ReplaceAllAction: 'editor.action.replaceAll',
	SelectAllMatchesAction: 'editor.action.selectAllMatches',
	//変更開始
	SwapAllAction: 'editor.action.swapAll'
	//変更終了
};

export const MATCHES_LIMIT = 19999;
const RESEARCH_DELAY = 240;

export class FindModelBoundToEditorModel {

	private readonly _editor: IActiveCodeEditor;
	private readonly _state: FindReplaceState;
	private readonly _toDispose = new DisposableStore();
	private readonly _decorations: FindDecorations;
	// ↓変更(2021/10/25)
	private readonly _decorationsForSwap: FindDecorations;
	private _ignoreModelContentChanged: boolean;
	private readonly _startSearchingTimer: TimeoutTimer;

	private readonly _updateDecorationsScheduler: RunOnceScheduler;
	private _isDisposed: boolean;

	constructor(editor: IActiveCodeEditor, state: FindReplaceState) {
		this._editor = editor;
		this._state = state;
		this._isDisposed = false;
		this._startSearchingTimer = new TimeoutTimer();

		this._decorations = new FindDecorations(editor);
		// ↓変更(2021/10/25)
		this._decorationsForSwap = new FindDecorations(editor);
		this._toDispose.add(this._decorations);
		// ↓変更(2021/10/25)
		this._toDispose.add(this._decorationsForSwap);

		this._updateDecorationsScheduler = new RunOnceScheduler(() => this.research(false), 100);
		this._toDispose.add(this._updateDecorationsScheduler);

		this._toDispose.add(this._editor.onDidChangeCursorPosition((e: ICursorPositionChangedEvent) => {
			if (
				e.reason === CursorChangeReason.Explicit
				|| e.reason === CursorChangeReason.Undo
				|| e.reason === CursorChangeReason.Redo
			) {
				this._decorations.setStartPosition(this._editor.getPosition());
			}
		}));

		this._ignoreModelContentChanged = false;
		this._toDispose.add(this._editor.onDidChangeModelContent((e) => {
			if (this._ignoreModelContentChanged) {
				return;
			}
			if (e.isFlush) {
				// a model.setValue() was called
				this._decorations.reset();
			}
			this._decorations.setStartPosition(this._editor.getPosition());
			this._updateDecorationsScheduler.schedule();
		}));

		this._toDispose.add(this._state.onFindReplaceStateChange((e) => this._onStateChanged(e)));

		this.research(false, this._state.searchScope);
	}

	public dispose(): void {
		this._isDisposed = true;
		dispose(this._startSearchingTimer);
		this._toDispose.dispose();
	}

	private _onStateChanged(e: FindReplaceStateChangedEvent): void {
		if (this._isDisposed) {
			// The find model is disposed during a find state changed event
			return;
		}
		if (!this._editor.hasModel()) {
			// The find model will be disposed momentarily
			return;
		}
		// ↓変更(2021/10/25 e.swapString)
		if (e.searchString || e.isReplaceRevealed || e.isRegex || e.wholeWord || e.matchCase || e.searchScope || e.swapString) {
			let model = this._editor.getModel();

			if (model.isTooLargeForSyncing()) {
				this._startSearchingTimer.cancel();

				this._startSearchingTimer.setIfNotSet(() => {
					if (e.searchScope) {
						this.research(e.moveCursor, this._state.searchScope);
					} else {
						this.research(e.moveCursor);
					}
				}, RESEARCH_DELAY);
			} else {
				if (e.searchScope) {
					this.research(e.moveCursor, this._state.searchScope);
				} else {
					this.research(e.moveCursor);
				}
			}
		}
	}

	private static _getSearchRange(model: ITextModel, findScope: Range | null): Range {
		// If we have set now or before a find scope, use it for computing the search range
		if (findScope) {
			return findScope;
		}

		return model.getFullModelRange();
	}

	private research(moveCursor: boolean, newFindScope?: Range | Range[] | null): void {
		let findScopes: Range[] | null = null;
		if (typeof newFindScope !== 'undefined') {
			if (newFindScope !== null) {
				if (!Array.isArray(newFindScope)) {
					findScopes = [newFindScope as Range];
				} else {
					findScopes = newFindScope;
				}
			}
		} else {
			findScopes = this._decorations.getFindScopes();
		}
		if (findScopes !== null) {
			findScopes = findScopes.map(findScope => {
				if (findScope.startLineNumber !== findScope.endLineNumber) {
					let endLineNumber = findScope.endLineNumber;

					if (findScope.endColumn === 1) {
						endLineNumber = endLineNumber - 1;
					}

					return new Range(findScope.startLineNumber, 1, endLineNumber, this._editor.getModel().getLineMaxColumn(endLineNumber));
				}
				return findScope;
			});
		}

		let findMatches = this._findMatches(findScopes, false, MATCHES_LIMIT);
		this._decorations.set(findMatches, findScopes);
		// 変更開始(2021/10/25)
		let findMatchesForSwap = this._findMatchesForSwap(findScopes, false, MATCHES_LIMIT);
		this._decorationsForSwap.set(findMatchesForSwap, findScopes);
		// 変更終了

		const editorSelection = this._editor.getSelection();
		let currentMatchesPosition = this._decorations.getCurrentMatchesPosition(editorSelection);
		if (currentMatchesPosition === 0 && findMatches.length > 0) {
			// current selection is not on top of a match
			// try to find its nearest result from the top of the document
			const matchAfterSelection = findFirstInSorted(findMatches.map(match => match.range), range => Range.compareRangesUsingStarts(range, editorSelection) >= 0);
			currentMatchesPosition = matchAfterSelection > 0 ? matchAfterSelection - 1 + 1 /** match position is one based */ : currentMatchesPosition;
		}

		this._state.changeMatchInfo(
			currentMatchesPosition,
			this._decorations.getCount(),
			undefined
		);

		if (moveCursor && this._editor.getOption(EditorOption.find).cursorMoveOnType) {
			this._moveToNextMatch(this._decorations.getStartPosition());
		}
	}

	private _hasMatches(): boolean {
		return (this._state.matchesCount > 0);
	}

	private _hasMatchesForSwap(): boolean {
		const findScopes = this._decorations.getFindScopes();
		let searchPattern = this._getSearchPattern();
		let matches = this._findMatchesForSwap(findScopes, searchPattern.hasReplacementPatterns || this._state.preserveCase, Constants.MAX_SAFE_SMALL_INTEGER);

		if (matches.length > 0) {
			return true;
		} else {
			return false;
		}
	}

	private _cannotFind(): boolean {
		if (!this._hasMatches()) {
			let findScope = this._decorations.getFindScope();
			if (findScope) {
				// Reveal the selection so user is reminded that 'selection find' is on.
				this._editor.revealRangeInCenterIfOutsideViewport(findScope, ScrollType.Smooth);
			}
			return true;
		}
		return false;
	}

	private _setCurrentFindMatch(match: Range): void {
		let matchesPosition = this._decorations.setCurrentFindMatch(match);
		this._state.changeMatchInfo(
			matchesPosition,
			this._decorations.getCount(),
			match
		);

		this._editor.setSelection(match);
		this._editor.revealRangeInCenterIfOutsideViewport(match, ScrollType.Smooth);
	}

	private _prevSearchPosition(before: Position) {
		let isUsingLineStops = this._state.isRegex && (
			this._state.searchString.indexOf('^') >= 0
			|| this._state.searchString.indexOf('$') >= 0
		);
		let { lineNumber, column } = before;
		let model = this._editor.getModel();

		if (isUsingLineStops || column === 1) {
			if (lineNumber === 1) {
				lineNumber = model.getLineCount();
			} else {
				lineNumber--;
			}
			column = model.getLineMaxColumn(lineNumber);
		} else {
			column--;
		}

		return new Position(lineNumber, column);
	}

	private _moveToPrevMatch(before: Position, isRecursed: boolean = false): void {
		if (!this._state.canNavigateBack()) {
			// we are beyond the first matched find result
			// instead of doing nothing, we should refocus the first item
			const nextMatchRange = this._decorations.matchAfterPosition(before);

			if (nextMatchRange) {
				this._setCurrentFindMatch(nextMatchRange);
			}
			return;
		}
		if (this._decorations.getCount() < MATCHES_LIMIT) {
			let prevMatchRange = this._decorations.matchBeforePosition(before);

			if (prevMatchRange && prevMatchRange.isEmpty() && prevMatchRange.getStartPosition().equals(before)) {
				before = this._prevSearchPosition(before);
				prevMatchRange = this._decorations.matchBeforePosition(before);
			}

			if (prevMatchRange) {
				this._setCurrentFindMatch(prevMatchRange);
			}

			return;
		}

		if (this._cannotFind()) {
			return;
		}

		let findScope = this._decorations.getFindScope();
		let searchRange = FindModelBoundToEditorModel._getSearchRange(this._editor.getModel(), findScope);

		// ...(----)...|...
		if (searchRange.getEndPosition().isBefore(before)) {
			before = searchRange.getEndPosition();
		}

		// ...|...(----)...
		if (before.isBefore(searchRange.getStartPosition())) {
			before = searchRange.getEndPosition();
		}

		let { lineNumber, column } = before;
		let model = this._editor.getModel();

		let position = new Position(lineNumber, column);

		let prevMatch = model.findPreviousMatch(this._state.searchString, position, this._state.isRegex, this._state.matchCase, this._state.wholeWord ? this._editor.getOption(EditorOption.wordSeparators) : null, false);

		if (prevMatch && prevMatch.range.isEmpty() && prevMatch.range.getStartPosition().equals(position)) {
			// Looks like we're stuck at this position, unacceptable!
			position = this._prevSearchPosition(position);
			prevMatch = model.findPreviousMatch(this._state.searchString, position, this._state.isRegex, this._state.matchCase, this._state.wholeWord ? this._editor.getOption(EditorOption.wordSeparators) : null, false);
		}

		if (!prevMatch) {
			// there is precisely one match and selection is on top of it
			return;
		}

		if (!isRecursed && !searchRange.containsRange(prevMatch.range)) {
			return this._moveToPrevMatch(prevMatch.range.getStartPosition(), true);
		}

		this._setCurrentFindMatch(prevMatch.range);
	}

	public moveToPrevMatch(): void {
		this._moveToPrevMatch(this._editor.getSelection().getStartPosition());
	}

	private _nextSearchPosition(after: Position) {
		let isUsingLineStops = this._state.isRegex && (
			this._state.searchString.indexOf('^') >= 0
			|| this._state.searchString.indexOf('$') >= 0
		);

		let { lineNumber, column } = after;
		let model = this._editor.getModel();

		if (isUsingLineStops || column === model.getLineMaxColumn(lineNumber)) {
			if (lineNumber === model.getLineCount()) {
				lineNumber = 1;
			} else {
				lineNumber++;
			}
			column = 1;
		} else {
			column++;
		}

		return new Position(lineNumber, column);
	}

	private _moveToNextMatch(after: Position): void {
		if (!this._state.canNavigateForward()) {
			// we are beyond the last matched find result
			// instead of doing nothing, we should refocus the last item
			const prevMatchRange = this._decorations.matchBeforePosition(after);

			if (prevMatchRange) {
				this._setCurrentFindMatch(prevMatchRange);
			}
			return;
		}
		if (this._decorations.getCount() < MATCHES_LIMIT) {
			let nextMatchRange = this._decorations.matchAfterPosition(after);

			if (nextMatchRange && nextMatchRange.isEmpty() && nextMatchRange.getStartPosition().equals(after)) {
				// Looks like we're stuck at this position, unacceptable!
				after = this._nextSearchPosition(after);
				nextMatchRange = this._decorations.matchAfterPosition(after);
			}
			if (nextMatchRange) {
				this._setCurrentFindMatch(nextMatchRange);
			}

			return;
		}

		let nextMatch = this._getNextMatch(after, false, true);
		if (nextMatch) {
			this._setCurrentFindMatch(nextMatch.range);
		}
	}

	private _getNextMatch(after: Position, captureMatches: boolean, forceMove: boolean, isRecursed: boolean = false): FindMatch | null {
		if (this._cannotFind()) {
			return null;
		}

		let findScope = this._decorations.getFindScope();
		let searchRange = FindModelBoundToEditorModel._getSearchRange(this._editor.getModel(), findScope);

		// ...(----)...|...
		if (searchRange.getEndPosition().isBefore(after)) {
			after = searchRange.getStartPosition();
		}

		// ...|...(----)...
		if (after.isBefore(searchRange.getStartPosition())) {
			after = searchRange.getStartPosition();
		}

		let { lineNumber, column } = after;
		let model = this._editor.getModel();

		let position = new Position(lineNumber, column);

		let nextMatch = model.findNextMatch(this._state.searchString, position, this._state.isRegex, this._state.matchCase, this._state.wholeWord ? this._editor.getOption(EditorOption.wordSeparators) : null, captureMatches);

		if (forceMove && nextMatch && nextMatch.range.isEmpty() && nextMatch.range.getStartPosition().equals(position)) {
			// Looks like we're stuck at this position, unacceptable!
			position = this._nextSearchPosition(position);
			nextMatch = model.findNextMatch(this._state.searchString, position, this._state.isRegex, this._state.matchCase, this._state.wholeWord ? this._editor.getOption(EditorOption.wordSeparators) : null, captureMatches);
		}

		if (!nextMatch) {
			// there is precisely one match and selection is on top of it
			return null;
		}

		if (!isRecursed && !searchRange.containsRange(nextMatch.range)) {
			return this._getNextMatch(nextMatch.range.getEndPosition(), captureMatches, forceMove, true);
		}

		return nextMatch;
	}

	public moveToNextMatch(): void {
		this._moveToNextMatch(this._editor.getSelection().getEndPosition());
	}

	private _getReplacePattern(): ReplacePattern {
		if (this._state.isRegex) {
			return parseReplaceString(this._state.replaceString);
		}
		return ReplacePattern.fromStaticValue(this._state.replaceString);
	}

	//変更開始
	private _getSearchPattern(): ReplacePattern {
		if (this._state.isRegex) {
			return parseReplaceString(this._state.searchString);
		}
		return ReplacePattern.fromStaticValue(this._state.searchString);
	}
	//変更終了

	//変更開始(2021/10/21)
	private _getSwapPattern(): ReplacePattern {
		if (this._state.isRegex) {
			return parseReplaceString(this._state.swapString);
		}
		return ReplacePattern.fromStaticValue(this._state.swapString);
	}
	//変更終了

	public replace(): void {
		if (!this._hasMatches()) {
			return;
		}

		let replacePattern = this._getReplacePattern();
		let selection = this._editor.getSelection();
		let nextMatch = this._getNextMatch(selection.getStartPosition(), true, false);
		if (nextMatch) {
			if (selection.equalsRange(nextMatch.range)) {
				// selection sits on a find match => replace it!
				let replaceString = replacePattern.buildReplaceString(nextMatch.matches, this._state.preserveCase);

				let command = new ReplaceCommand(selection, replaceString);

				this._executeEditorCommand('replace', command);

				this._decorations.setStartPosition(new Position(selection.startLineNumber, selection.startColumn + replaceString.length));
				this.research(true);
			} else {
				this._decorations.setStartPosition(this._editor.getPosition());
				this._setCurrentFindMatch(nextMatch.range);
			}
		}
	}

	private _findMatches(findScopes: Range[] | null, captureMatches: boolean, limitResultCount: number): FindMatch[] {
		const searchRanges = (findScopes as [] || [null]).map((scope: Range | null) =>
			FindModelBoundToEditorModel._getSearchRange(this._editor.getModel(), scope)
		);

		return this._editor.getModel().findMatches(this._state.searchString, searchRanges, this._state.isRegex, this._state.matchCase, this._state.wholeWord ? this._editor.getOption(EditorOption.wordSeparators) : null, captureMatches, limitResultCount);
	}

	//変更開始
	private _findMatchesForSwap(findScopes: Range[] | null, captureMatches: boolean, limitResultCount: number): FindMatch[] {
		const searchRanges = (findScopes as [] || [null]).map((scope: Range | null) =>
			FindModelBoundToEditorModel._getSearchRange(this._editor.getModel(), scope)
		);

		return this._editor.getModel().findMatches(this._state.swapString, searchRanges, false, true, this._state.wholeWordForSwap ? this._editor.getOption(EditorOption.wordSeparators) : null, captureMatches, limitResultCount);
	}
	//変更終了

	public replaceAll(): void {
		if (!this._hasMatches()) {
			return;
		}

		const findScopes = this._decorations.getFindScopes();

		if (findScopes === null && this._state.matchesCount >= MATCHES_LIMIT) {
			// Doing a replace on the entire file that is over ${MATCHES_LIMIT} matches
			this._largeReplaceAll();
		} else {
			this._regularReplaceAll(findScopes);
		}

		this.research(false);
	}

	private _largeReplaceAll(): void {
		const searchParams = new SearchParams(this._state.searchString, this._state.isRegex, this._state.matchCase, this._state.wholeWord ? this._editor.getOption(EditorOption.wordSeparators) : null);
		const searchData = searchParams.parseSearchRequest();
		if (!searchData) {
			return;
		}

		let searchRegex = searchData.regex;
		if (!searchRegex.multiline) {
			let mod = 'mu';
			if (searchRegex.ignoreCase) {
				mod += 'i';
			}
			if (searchRegex.global) {
				mod += 'g';
			}
			searchRegex = new RegExp(searchRegex.source, mod);
		}

		const model = this._editor.getModel();
		const modelText = model.getValue(EndOfLinePreference.LF);
		const fullModelRange = model.getFullModelRange();

		const replacePattern = this._getReplacePattern();
		let resultText: string;
		const preserveCase = this._state.preserveCase;

		if (replacePattern.hasReplacementPatterns || preserveCase) {
			resultText = modelText.replace(searchRegex, function () {
				return replacePattern.buildReplaceString(<string[]><any>arguments, preserveCase);
			});
		} else {
			resultText = modelText.replace(searchRegex, replacePattern.buildReplaceString(null, preserveCase));
		}

		let command = new ReplaceCommandThatPreservesSelection(fullModelRange, resultText, this._editor.getSelection());
		this._executeEditorCommand('replaceAll', command);
	}

	private _regularReplaceAll(findScopes: Range[] | null): void {
		const replacePattern = this._getReplacePattern();
		// Get all the ranges (even more than the highlighted ones)
		let matches = this._findMatches(findScopes, replacePattern.hasReplacementPatterns || this._state.preserveCase, Constants.MAX_SAFE_SMALL_INTEGER);

		let replaceStrings: string[] = [];
		for (let i = 0, len = matches.length; i < len; i++) {
			replaceStrings[i] = replacePattern.buildReplaceString(matches[i].matches, this._state.preserveCase);
		}

		let command = new ReplaceAllCommand(this._editor.getSelection(), matches.map(m => m.range), replaceStrings);
		this._executeEditorCommand('replaceAll', command);
	}

	//変更開始
	public swapAll(): void {
		if (this._state.isRegex || !this._state.matchCase) {
			return;
		}
		if (!(this._hasMatches() && this._hasMatchesForSwap())) {
			return;
		}

		const findScopes = this._decorations.getFindScopes();

		if (findScopes === null && this._state.matchesCount >= MATCHES_LIMIT) {
			// Doing a replace on the entire file that is over ${MATCHES_LIMIT} matches
			this._largeSwapAll();
		} else {
			this._regularSwapAll(findScopes);
		}

		this.research(false);
	}

	//変更未完成関数
	private _largeSwapAll(): void {
		const searchParams = new SearchParams(this._state.searchString, this._state.isRegex, this._state.matchCase, this._state.wholeWord ? this._editor.getOption(EditorOption.wordSeparators) : null);
		const searchData = searchParams.parseSearchRequest();
		if (!searchData) {
			return;
		}

		let searchRegex = searchData.regex;
		if (!searchRegex.multiline) {
			let mod = 'mu';
			if (searchRegex.ignoreCase) {
				mod += 'i';
			}
			if (searchRegex.global) {
				mod += 'g';
			}
			searchRegex = new RegExp(searchRegex.source, mod);
		}

		const model = this._editor.getModel();
		const modelText = model.getValue(EndOfLinePreference.LF);
		const fullModelRange = model.getFullModelRange();

		const replacePattern = this._getReplacePattern();
		let resultText: string;
		const preserveCase = this._state.preserveCase;

		if (replacePattern.hasReplacementPatterns || preserveCase) {
			resultText = modelText.replace(searchRegex, function () {
				return replacePattern.buildReplaceString(<string[]><any>arguments, preserveCase);
			});
		} else {
			resultText = modelText.replace(searchRegex, replacePattern.buildReplaceString(null, preserveCase));
		}

		let command = new ReplaceCommandThatPreservesSelection(fullModelRange, resultText, this._editor.getSelection());
		this._executeEditorCommand('replaceAll', command);
	}

	private _regularSwapAll(findScopes: Range[] | null): void {
		const swapPattern = this._getSwapPattern();
		const searchPattern = this._getSearchPattern();
		// Get all the ranges (even more than the highlighted ones)
		let matchesForFindInput = this._findMatches(findScopes, swapPattern.hasReplacementPatterns || this._state.preserveCase, Constants.MAX_SAFE_SMALL_INTEGER);

		//swap用に作ったやつ
		let matchesForSwapInput = this._findMatchesForSwap(findScopes, searchPattern.hasReplacementPatterns || this._state.preserveCase, Constants.MAX_SAFE_SMALL_INTEGER);

		let swapStringsForFindInput: string[] = [];
		for (let i = 0, len = matchesForFindInput.length; i < len; i++) {
			swapStringsForFindInput[i] = swapPattern.buildReplaceString(matchesForFindInput[i].matches, this._state.preserveCase);
		}

		let swapStringsForSwapInput: string[] = [];
		for (let i = 0, len = matchesForSwapInput.length; i < len; i++) {
			swapStringsForSwapInput[i] = searchPattern.buildReplaceString(matchesForSwapInput[i].matches, this._state.preserveCase);
		}
		let command = new SwapAllCommand(this._editor.getSelection(), matchesForFindInput.map(m => m.range), swapStringsForFindInput, matchesForSwapInput.map(m => m.range), swapStringsForSwapInput);
		// 変更開始
		this._executeEditorCommand('swapAll', command);
		// 変更終了
	}
	//変更終了

	public selectAllMatches(): void {
		if (!this._hasMatches()) {
			return;
		}

		let findScopes = this._decorations.getFindScopes();

		// Get all the ranges (even more than the highlighted ones)
		let matches = this._findMatches(findScopes, false, Constants.MAX_SAFE_SMALL_INTEGER);
		let selections = matches.map(m => new Selection(m.range.startLineNumber, m.range.startColumn, m.range.endLineNumber, m.range.endColumn));

		// If one of the ranges is the editor selection, then maintain it as primary
		let editorSelection = this._editor.getSelection();
		for (let i = 0, len = selections.length; i < len; i++) {
			let sel = selections[i];
			if (sel.equalsRange(editorSelection)) {
				selections = [editorSelection].concat(selections.slice(0, i)).concat(selections.slice(i + 1));
				break;
			}
		}

		this._editor.setSelections(selections);
	}

	private _executeEditorCommand(source: string, command: ICommand): void {
		try {
			this._ignoreModelContentChanged = true;
			this._editor.pushUndoStop();
			this._editor.executeCommand(source, command);
			this._editor.pushUndoStop();
		} finally {
			this._ignoreModelContentChanged = false;
		}
	}
}
