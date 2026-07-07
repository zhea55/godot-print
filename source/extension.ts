import * as vscode from "vscode";

// ─── Constants ───────────────────────────────────────────────────────────────

const NAMESPACE = "godot-print";

const DEFAULT_PRINT_TEMPLATES: Record<string, string> = {
    gdscript: 'print("[{className}] {body}")',
    csharp: 'Godot.GD.Print($"[{className}] {body}");',
};

// ─── Configuration ───────────────────────────────────────────────────────────

interface ExtensionConfig {
    printTemplates: Record<string, string>;
    expandVectors: boolean;
}

function loadConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration(NAMESPACE);
    return {
        printTemplates: {
            gdscript:
                config.get<string>("printTemplate.gdscript") ?? DEFAULT_PRINT_TEMPLATES.gdscript,
            csharp: config.get<string>("printTemplate.csharp") ?? DEFAULT_PRINT_TEMPLATES.csharp,
        },
        expandVectors: config.get<boolean>("expandVectors") ?? true,
    };
}

// ─── Language Detection ──────────────────────────────────────────────────────

type GodotLang = "gdscript" | "csharp";

function detectGodotLang(document: vscode.TextDocument): GodotLang {
    const langId = document.languageId;
    if (langId === "gdscript") return "gdscript";
    if (langId === "csharp") return "csharp";

    // Fallback to file extension
    const filePath = document.fileName.toLowerCase();
    if (filePath.endsWith(".gd")) return "gdscript";
    if (filePath.endsWith(".cs")) return "csharp";

    // Content-based heuristic: look for GDScript-specific patterns
    const text = document.getText();
    if (/^(extends|class_name|signal|func\s+\w+\s*\([^)]*\)\s*:)/m.test(text)) {
        return "gdscript";
    }
    if (/^(using |namespace |class \w+\s*:)/m.test(text)) {
        return "csharp";
    }

    // Default to GDScript (more likely in Godot projects)
    return "gdscript";
}

// ─── GDScript / C# Parser Utilities ──────────────────────────────────────────

/**
 * Extracts the class name from a Godot script document.
 *
 * C#:   `class Foo : Bar`  →  `Foo`
 * GDScript: `class_name Foo` or `class Foo`  →  `Foo`
 * Fallback: file name stem.
 */
function extractClassName(document: vscode.TextDocument, lang: GodotLang): string {
    const text = document.getText();

    if (lang === "csharp") {
        // class Foo : Bar  or  partial class Foo ...
        const m = text.match(/^\s*(?:public\s+|partial\s+|static\s+)*class\s+(\w+)/m);
        if (m) return m[1];
    } else {
        // class_name Foo  or  class Foo (inner class)
        const m = text.match(/^\s*class(?:_name)?\s+(\w+)/m);
        if (m) return m[1];
    }

    // Fallback: file stem
    const segments = document.fileName.split(/[/\\]/);
    const filename = segments.pop() ?? "";
    return filename.replace(/\.[^.]+$/, "") || "Unknown";
}

/**
 * Extracts variable name from an assignment line.
 *
 * Supports:
 *   - `x = 1`
 *   - `var x = 1`
 *   - `x := some_func()`
 *   - `x += 1`
 *   - `@export var x := 1`
 *   - `x: int = 1`
 *   - `int x = 1`           (C#)
 *   - `var x = 1;`          (C#)
 *
 * Returns the variable name, or `null` if the line is not an assignment.
 */
function extractVariableName(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Strip trailing semicolon for C#
    const clean = trimmed.replace(/;$/, "");

    // Supports:
    //   (decorator )?(var/type )? name (: type)?  =  |  :=  |  +=  |  etc.
    // Uses (=)(?!=) to avoid matching == (comparison).
    // Captures the full LHS (left-hand side) of an assignment:
    //   simple name (x), member access (pos.X, player.position),
    //   array access (items[0]), or mixed (player.inventory[0].name)
    const match = clean.match(
        /^(?:@\w+\s+)?(?:(?:var|int|float|bool|string|double|Vector[234]|Color|Rect2|Transform[23]?D)\s+)?((?:\w[\w\d]*)(?:\s*\.\s*\w[\w\d]*|\s*\[\s*\w[\w\d]*\s*\])*)(?:\s*:\s*\w+(?:\[\])?)?\s*(?:=(?!=)|\+=|-=|\*=|(?:\/)=|:=)/,
    );
    return match?.[1] ?? null;
}

/**
 * Extracts variable names from selected text, handling multi-line assignments.
 *
 * A line like `var score = calculate_score(` has the variable name BEFORE the
 * dangling paren — so we extract it right away, then skip continuation lines
 * while paren depth > 0.
 */
function extractVariablesFromSelection(selectedText: string): string[] {
    const lines = selectedText.split("\n");
    const variables: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;

        // Try extraction on every line — variable name comes before the value
        // expression, so it works even inside parens (e.g., `var x = foo(`).
        const name = extractVariableName(trimmed);
        if (name) {
            variables.push(name);
        }
    }

    return variables;
}

/**
 * Generates a print statement from variables using the appropriate template.
 */
function generatePrintStatement(
    className: string,
    variables: string[],
    indent: string,
    template: string,
): string {
    const body = variables.map((v) => `${v}={${v}}`).join(", ");
    return `${indent}${template.replace("{className}", className).replace("{body}", body)}`;
}

/** Returns the leading whitespace of a given line. */
function getLineIndent(document: vscode.TextDocument, line: number): string {
    if (line < 0 || line >= document.lineCount) return "";
    const m = document.lineAt(line).text.match(/^\s*/);
    return m?.[0] ?? "";
}

/**
 * Returns the indent to use when inserting a line at `insertLine`.
 *
 * When inserting right after a block header (`:` in GDScript, `{` in C#),
 * detects the block body's actual indent from subsequent lines so the print
 * aligns with existing content instead of using the header's indent.
 */
function getInsertIndent(
    document: vscode.TextDocument,
    insertLine: number,
    lang: GodotLang,
): string {
    if (insertLine <= 0) return "";

    const prevLine = document.lineAt(insertLine - 1).text;
    const trimmed = prevLine.trim();

    const isBlockHeader =
        (lang === "gdscript" && trimmed.endsWith(":") && !trimmed.startsWith("#")) ||
        trimmed === "{" ||
        (lang === "csharp" && trimmed.endsWith("{"));

    if (isBlockHeader) {
        const base = getLineIndent(document, insertLine - 1);
        for (let i = insertLine; i < document.lineCount; i++) {
            const line = document.lineAt(i).text;
            if (line.trim().length > 0 && !line.trim().startsWith("#")) {
                const lineIndent = line.match(/^\s*/)?.[0] ?? "";
                if (lineIndent.length > base.length) return lineIndent;
                break;
            }
        }
        return `${base}    `; // fallback: 4 deeper
    }

    return getLineIndent(document, Math.min(insertLine - 1, document.lineCount - 1));
}

// ─── Cursor Expression Extraction ────────────────────────────────────────────

/**
 * Extracts an expression (identifier, member access, array index) under the
 * cursor by expanding left/right through word, dot, and bracket characters.
 *
 *   `pos.X`          → cursor anywhere inside → `pos.X`
 *   `player.health`  → same                  → `player.health`
 *   `items[0]`       → same                  → `items[0]`
 */
function getExpressionAtCursor(
    document: vscode.TextDocument,
    cursor: vscode.Position,
): string | null {
    const line = document.lineAt(cursor.line).text;
    if (!line) return null;

    const isExprChar = (ch: string) => /[\w.[\]]/.test(ch);
    let start = cursor.character;
    let end = cursor.character;

    // Expand left
    while (start > 0 && isExprChar(line[start - 1])) start--;
    // Expand right
    while (end < line.length && isExprChar(line[end])) end++;

    const expr = line.slice(start, end).trim();
    return expr.length > 0 ? expr : null;
}

// ─── Statement End Detection ─────────────────────────────────────────────────

/**
 * Scans forward from `fromLine` to find where the current statement ends,
 * handling multi-line expressions like:
 *
 *   pos.X += vel.X            ← cursor here
 *            * Tick.deltaTime; → returns this line (line with `;`)
 *
 * Strategy:
 *   - C#:  scan to `;` (tracking paren depth), OR stop at `{` to go inside block
 *   - GDScript: scan until no continuation operator on next line
 */
function findStatementEndLine(
    document: vscode.TextDocument,
    fromLine: number,
    lang: GodotLang,
): number {
    let parenDepth = 0;

    for (let i = fromLine; i < document.lineCount; i++) {
        const text = document.lineAt(i).text;

        if (lang === "csharp") {
            let bracketDepth = 0;
            for (const ch of text) {
                if (ch === "(" || ch === "[") parenDepth++;
                if (ch === ")" || ch === "]") parenDepth--;
                if (ch === "{") bracketDepth++;
                if (ch === "}") bracketDepth--;
            }
            if (parenDepth > 0) continue;
            // Entered a block → return so insert goes inside it
            if (bracketDepth > 0) return i;
            if (text.includes(";")) return i;
        } else {
            let bracketDepth = 0;
            for (const ch of text) {
                if (ch === "(" || ch === "[") parenDepth++;
                if (ch === ")" || ch === "]") parenDepth--;
                if (ch === "{") bracketDepth++;
                if (ch === "}") bracketDepth--;
            }
            if (parenDepth > 0 || bracketDepth > 0) continue;

            const trimmed = text.trim();
            if (!trimmed) continue;

            const nextLine =
                i + 1 < document.lineCount ? document.lineAt(i + 1).text.trimStart() : "";
            if (/^[.*+/\-[\](\s]/.test(nextLine)) continue;

            return i;
        }
    }

    return fromLine;
}

// ─── Vector Type Expansion ──────────────────────────────────────────────

const VECTOR_TYPES = new Set([
    "Vector2",
    "Vector2I",
    "Vector3",
    "Vector3I",
    "Vector4",
    "Vector4I",
    "Color",
]);

function getVectorComponents(type: string, lang: GodotLang): string[] {
    const c = (name: string) => (lang === "csharp" ? name.toUpperCase() : name.toLowerCase());

    if (type === "Color") return lang === "csharp" ? ["R", "G", "B", "A"] : ["r", "g", "b", "a"];
    if (type.endsWith("4")) return [c("x"), c("y"), c("z"), c("w")];
    if (type.endsWith("3")) return [c("x"), c("y"), c("z")];
    return [c("x"), c("y")];
}

function findVarType(
    document: vscode.TextDocument,
    varName: string,
    fromLine: number,
): string | null {
    const typePattern = new RegExp(`(?:^|\\s)(Vector[234](?:I)?|Color)\\s+${varName}\\b`);
    for (let i = Math.min(fromLine, document.lineCount - 1); i >= 0; i--) {
        const line = document.lineAt(i).text;
        const m = line.match(typePattern);
        if (m) return m[1];
        const gdMatch = line.match(
            new RegExp(`(?:^|\\s)var\\s+${varName}\\s*:\\s*(Vector[234](?:I)?|Color)\\b`),
        );
        if (gdMatch) return gdMatch[1];
    }
    return null;
}

function expandVectorVars(
    variables: string[],
    document: vscode.TextDocument,
    fromLine: number,
    config: ExtensionConfig,
    lang: GodotLang,
): string[] {
    if (!config.expandVectors) return variables;
    return variables.flatMap((v) => {
        if (!/^\w+$/.test(v)) return [v];
        const type = findVarType(document, v, fromLine);
        if (type && VECTOR_TYPES.has(type)) {
            return getVectorComponents(type, lang).map((c) => `${v}.${c}`);
        }
        return [v];
    });
}

// ─── Print Command ───────────────────────────────────────────────────────────

/**
 * Three modes:
 *  1. Selection with assignments → extract variable names (original behavior)
 *  2. Selection without assignments → use selected text as expression(s)
 *  3. No selection → extract expression under cursor
 */
function executePrint(editor: vscode.TextEditor, config: ExtensionConfig): void {
    const document = editor.document;
    const selection = editor.selection;
    const lang = detectGodotLang(document);
    const className = extractClassName(document, lang);
    const template = config.printTemplates[lang] ?? DEFAULT_PRINT_TEMPLATES[lang];

    let variables: string[] = [];

    if (!selection.isEmpty) {
        const selectedText = document.getText(selection);
        if (selectedText.trim()) {
            // Mode 1: try parsing as assignments first
            variables = extractVariablesFromSelection(selectedText);
        }

        // Mode 2: if no assignments found, use selected text directly
        // Split by newlines and commas so `heroPos.X, heroPos.Y` becomes two expressions
        if (variables.length === 0) {
            variables = selectedText
                .split(/[\n,]+/)
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
        }
    }

    // Mode 3: no selection → extract expression under cursor
    if (variables.length === 0) {
        const expr = getExpressionAtCursor(document, selection.active);
        if (expr) variables = [expr];
    }

    if (variables.length === 0) {
        vscode.window.showWarningMessage("No variable or expression found.");
        return;
    }

    // Expand vector-typed variables to their components (Vector2 → .X/.Y, etc.)
    variables = expandVectorVars(variables, document, selection.end.line, config, lang);

    // Find where the statement actually ends (handles multi-line assignments)
    const insertLine = findStatementEndLine(document, selection.end.line, lang) + 1;
    const insertPos = new vscode.Position(insertLine, 0);

    const indent = getInsertIndent(document, insertLine, lang);
    const printLine = generatePrintStatement(className, variables, indent, template);

    editor
        .edit((builder) => builder.insert(insertPos, `${printLine}\n`))
        .then((ok) => {
            if (!ok) return;

            const cursorPos = new vscode.Position(insertLine + 1, 0);
            editor.selection = new vscode.Selection(cursorPos, cursorPos);
            editor.revealRange(
                new vscode.Range(cursorPos, cursorPos),
                vscode.TextEditorRevealType.InCenterIfOutsideViewport,
            );
        });
}

// ─── Clean Command ───────────────────────────────────────────────────────────

/**
 * Scans forward from `startLine` tracking parenthesis depth to find where
 * a print call ends (handles multi-line calls).
 */
function findPrintEndLine(lines: string[], startLine: number): number {
    let depth = 0;
    let inCall = false;

    for (let i = startLine; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === "(") {
                depth++;
                inCall = true;
            } else if (ch === ")") {
                depth--;
            }
        }
        if (inCall && depth <= 0) return i;
    }

    return lines.length - 1; // safety: last line
}

function executeClean(editor: vscode.TextEditor): void {
    const document = editor.document;
    const lines = document.getText().split("\n");

    const rangesToDelete: vscode.Range[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Match either Godot.GD.Print(...) or print(...)
        const isPrintLine = line.includes("Godot.GD.Print") || /^\s*print\s*\(/.test(line);
        if (!isPrintLine) continue;

        const endLine = findPrintEndLine(lines, i);

        // Delete from start of this line to the start of the NEXT line
        // (so the trailing newline is consumed too)
        const start = new vscode.Position(i, 0);
        const end =
            endLine + 1 < lines.length
                ? new vscode.Position(endLine + 1, 0)
                : new vscode.Position(endLine, lines[endLine].length);

        rangesToDelete.push(new vscode.Range(start, end));
        i = endLine; // will be incremented by loop
    }

    if (rangesToDelete.length === 0) {
        vscode.window.showInformationMessage("No debug prints found.");
        return;
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(
        document.uri,
        rangesToDelete.map((r) => vscode.TextEdit.delete(r)),
    );

    vscode.workspace.applyEdit(workspaceEdit).then((ok) => {
        if (ok) {
            vscode.window.showInformationMessage(
                `Removed ${rangesToDelete.length} debug print(s).`,
            );
        }
    });
}

// ─── Activation ──────────────────────────────────────────────────────────────

let currentConfig: ExtensionConfig;

function reloadConfig(): void {
    currentConfig = loadConfig();
}

export function activate(context: vscode.ExtensionContext) {
    reloadConfig();

    const printCmd = vscode.commands.registerCommand(`${NAMESPACE}.print`, () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("No active text editor.");
            return;
        }
        executePrint(editor, currentConfig);
    });

    const cleanCmd = vscode.commands.registerCommand(`${NAMESPACE}.clean`, () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("No active text editor.");
            return;
        }
        executeClean(editor);
    });

    context.subscriptions.push(printCmd, cleanCmd);

    // Re-read config when user changes settings
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(NAMESPACE)) {
                reloadConfig();
            }
        }),
    );
}

export function deactivate() {
    // Subscriptions disposed automatically by VS Code
}
