import _ from 'lodash'
import addMissingProperties from './codeFixes/addMissingProperties'
import { changeSortingOfAutoImport, getIgnoreAutoImportSetting, isAutoImportEntryShouldBeIgnored } from './adjustAutoImports'
import { GetConfig } from './types'
import { findChildContainingPosition, getIndentFromPos } from './utils'

// codeFixes that I managed to put in files
const externalCodeFixes = [addMissingProperties]

export default (proxy: ts.LanguageService, languageService: ts.LanguageService, c: GetConfig, languageServiceHost: ts.LanguageServiceHost) => {
    proxy.getCodeFixesAtPosition = (fileName, start, end, errorCodes, formatOptions, preferences) => {
        const sourceFile = languageService.getProgram()?.getSourceFile(fileName)!
        const node = findChildContainingPosition(ts, sourceFile, start)

        const { Diagnostics } = tsFull
        const moduleSymbolDescriptionPlaceholders: [d: any /* Diagnostic */, modulePlaceholderIndex: number, symbolNamePlaceholderIndex?: number][] = [
            [Diagnostics.Import_0_from_1, 1, 0],
            [Diagnostics.Update_import_from_0, 0],
            [Diagnostics.Update_import_from_0, 0],
            [Diagnostics.Add_import_from_0, 0],
            // not sure of these ones
            [Diagnostics.Remove_type_from_import_of_0_from_1, 1, 0],
            [Diagnostics.Remove_type_from_import_declaration_from_0, 0],
        ]
        const oldCreateCodeFixAction = tsFull.codefix.createCodeFixAction
        let prior: readonly ts.CodeFixAction[]
        try {
            const { importFixName } = tsFull.codefix
            const ignoreAutoImportsSetting = getIgnoreAutoImportSetting(c)
            const sortFn = changeSortingOfAutoImport(c, (node as ts.Identifier).text)
            tsFull.codefix.createCodeFixAction = (fixName, changes, description, fixId, fixAllDescription, command) => {
                if (fixName !== importFixName) return oldCreateCodeFixAction(fixName, changes, description, fixId, fixAllDescription, command)
                const placeholderIndexesInfo = moduleSymbolDescriptionPlaceholders.find(([diag]) => diag === description[0])
                let sorting = '-1'
                if (placeholderIndexesInfo) {
                    const targetModule = description[placeholderIndexesInfo[1] + 1]
                    const symbolName = placeholderIndexesInfo[2] !== undefined ? description[placeholderIndexesInfo[2] + 1] : (node as ts.Identifier).text
                    const toIgnore = isAutoImportEntryShouldBeIgnored(ignoreAutoImportsSetting, targetModule, symbolName)
                    if (toIgnore) {
                        return {
                            fixName: 'IGNORE',
                            changes: [],
                            description: '',
                        }
                    }
                    sorting = sortFn(targetModule).toString()
                    // todo this workaround is weird, sort in another way
                }
                return oldCreateCodeFixAction(fixName + sorting, changes, description, fixId, fixAllDescription, command)
            }
            prior = languageService.getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, preferences)
            prior = _.sortBy(prior, ({ fixName }) => {
                if (fixName.startsWith(importFixName)) {
                    return +fixName.slice(importFixName.length)
                }
                return 0
            })
            prior = prior.filter(x => x.fixName !== 'IGNORE')
        } catch (err) {
            prior = languageService.getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, preferences)
            setTimeout(() => {
                // make sure we still get code fixes, but error is still getting reported
                throw err
            })
        } finally {
            tsFull.codefix.createCodeFixAction = oldCreateCodeFixAction
        }
        // todo remove when 5.0 is released after 3 months
        // #region fix builtin codefixes/refactorings
        prior.forEach(fix => {
            if (fix.fixName === 'fixConvertConstToLet') {
                const { start, length } = fix.changes[0]!.textChanges[0]!.span
                const fixedLength = 'const'.length as 5
                fix.changes[0]!.textChanges[0]!.span.start = start + length - fixedLength
                fix.changes[0]!.textChanges[0]!.span.length = fixedLength
            }
            return fix
        })
        // #endregion

        const semanticDiagnostics = languageService.getSemanticDiagnostics(fileName)
        const syntacicDiagnostics = languageService.getSyntacticDiagnostics(fileName)

        // https://github.com/Microsoft/TypeScript/blob/v4.5.5/src/compiler/diagnosticMessages.json#L458
        const findDiagnosticByCode = (codes: number[]) => {
            const errorCode = codes.find(code => errorCodes.includes(code))
            if (!errorCode) return
            const diagnosticPredicate = ({ code, start: localStart }) => code === errorCode && localStart === start
            return syntacicDiagnostics.find(diagnosticPredicate) || semanticDiagnostics.find(diagnosticPredicate)
        }

        const wrapBlockDiagnostics = findDiagnosticByCode([1156, 1157])
        if (wrapBlockDiagnostics) {
            const program = languageService.getProgram()
            const sourceFile = program!.getSourceFile(fileName)!
            const startIndent = getIndentFromPos(ts, sourceFile, end)
            prior = [
                ...prior,
                {
                    fixName: 'wrapBlock',
                    description: 'Wrap in block',
                    changes: [
                        {
                            fileName,
                            textChanges: [
                                { span: { start: wrapBlockDiagnostics.start!, length: 0 }, newText: `{\n${startIndent}\t` },
                                { span: { start: wrapBlockDiagnostics.start! + wrapBlockDiagnostics.length!, length: 0 }, newText: `\n${startIndent}}` },
                            ],
                        },
                    ],
                },
            ]
        }

        for (const codeFix of externalCodeFixes) {
            const diagnostic = findDiagnosticByCode(codeFix.codes)
            if (!diagnostic || !node) continue
            const suggestedCodeFix = codeFix.provideFix(diagnostic, node, sourceFile, languageService)
            if (!suggestedCodeFix) continue
            prior = [suggestedCodeFix, ...prior]
        }

        // TODO add our ids to enum of this setting
        if (c('removeCodeFixes.enable')) {
            const toRemove = c('removeCodeFixes.codefixes')
            prior = prior.filter(({ fixName }) => !toRemove.includes(fixName as any))
        }

        if (c('markTsCodeFixes.character')) prior = prior.map(item => ({ ...item, description: `${c('markTsCodeFixes.character')} ${item.description}` }))

        prior.forEach(fix => {
            // don't let it trigger on ctrl+s https://github.com/microsoft/vscode/blob/e8a3071ea4344d9d48ef8a4df2c097372b0c5161/extensions/typescript-language-features/src/languageFeatures/fixAll.ts#L142
            if (fix.fixName === 'fixAwaitInSyncFunction') {
                fix.fixName = 'ignoreFixAwaitInSyncFunction'
            }
        })

        return prior
    }

    proxy.getCombinedCodeFix = (scope, fixId, formatOptions, preferences) => {
        const { fileName } = scope
        if (fixId === 'fixMissingImport') {
            const program = languageService.getProgram()!
            const sourceFile = program.getSourceFile(fileName)!
            const importAdder = tsFull.codefix.createImportAdder(
                sourceFile as any,
                program as any,
                preferences,
                languageServiceHost as any /* cancellationToken */,
            )
            const semanticDiagnostics = languageService.getSemanticDiagnostics(fileName)
            const cancellationToken = languageServiceHost.getCompilerHost?.()?.getCancellationToken?.() ?? {
                isCancellationRequested: () => false,
                throwIfCancellationRequested: () => {},
            }
            const context: Record<keyof import('typescript-full').CodeFixContextBase, any> = {
                cancellationToken,
                formatContext: tsFull.formatting.getFormatContext(formatOptions, languageServiceHost),
                host: languageServiceHost,
                preferences,
                program,
                sourceFile,
            }
            const errorCodes = getFixAllErrorCodes()
            const ignoreAutoImportsSetting = getIgnoreAutoImportSetting(c)
            for (const diagnostic of semanticDiagnostics) {
                if (!errorCodes.includes(diagnostic.code)) continue
                const oldFirst = tsFull.first
                const oldForEachExternalModuleToImportFrom = tsFull.forEachExternalModuleToImportFrom
                try {
                    tsFull.first = ((fixes: FixInfo[]) => {
                        const sortFn = changeSortingOfAutoImport(c, fixes[0]!.symbolName)
                        fixes = _.sortBy(
                            fixes.filter(({ fix, symbolName }) => {
                                if (fix.kind === (ImportFixKind.PromoteTypeOnly as number)) return false
                                const shouldBeIgnored =
                                    c('autoImport.alwaysIgnoreInImportAll').includes(fix.moduleSpecifier) ||
                                    isAutoImportEntryShouldBeIgnored(ignoreAutoImportsSetting, fix.moduleSpecifier, symbolName)
                                return !shouldBeIgnored
                            }),
                            ({ fix }) => sortFn(fix.moduleSpecifier),
                        )
                        return fixes[0]
                    }) as any
                    // patching is fun
                    tsFull.forEachExternalModuleToImportFrom = (program, host, preferences, _useAutoImportProvider, cb) => {
                        return oldForEachExternalModuleToImportFrom(program, host, preferences, true, cb)
                    }
                    importAdder.addImportFromDiagnostic({ ...diagnostic, file: sourceFile as any } as any, context)
                } finally {
                    tsFull.first = oldFirst
                    tsFull.forEachExternalModuleToImportFrom = oldForEachExternalModuleToImportFrom
                }
            }
            return tsFull.codefix.createCombinedCodeActions(tsFull.textChanges.ChangeTracker.with(context, importAdder.writeFixes))
        }
        return languageService.getCombinedCodeFix(scope, fixId, formatOptions, preferences)
    }
}

const getFixAllErrorCodes = () => {
    const { Diagnostics } = tsFull
    const errorCodes = [
        Diagnostics.Cannot_find_name_0.code,
        Diagnostics.Cannot_find_name_0_Did_you_mean_1.code,
        Diagnostics.Cannot_find_name_0_Did_you_mean_the_instance_member_this_0.code,
        Diagnostics.Cannot_find_name_0_Did_you_mean_the_static_member_1_0.code,
        Diagnostics.Cannot_find_namespace_0.code,
        Diagnostics._0_refers_to_a_UMD_global_but_the_current_file_is_a_module_Consider_adding_an_import_instead.code,
        Diagnostics._0_only_refers_to_a_type_but_is_being_used_as_a_value_here.code,
        Diagnostics.No_value_exists_in_scope_for_the_shorthand_property_0_Either_declare_one_or_provide_an_initializer.code,
        Diagnostics._0_cannot_be_used_as_a_value_because_it_was_imported_using_import_type.code,
    ]
    return errorCodes
}

interface FixInfo {
    readonly fix: ImportFix
    readonly symbolName: string
    readonly errorIdentifierText: string | undefined
    readonly isJsxNamespaceFix?: boolean
}

type ImportFix = FixUseNamespaceImport | FixAddJsdocTypeImport | FixAddToExistingImport | FixAddNewImport
// type ImportFixWithModuleSpecifier = FixUseNamespaceImport | FixAddJsdocTypeImport | FixAddToExistingImport | FixAddNewImport;

const enum ImportFixKind {
    UseNamespace,
    JsdocTypeImport,
    AddToExisting,
    AddNew,
    PromoteTypeOnly,
}
type SymbolExportInfo = import('typescript-full').SymbolExportInfo

// Properties are be undefined if fix is derived from an existing import
interface ImportFixBase {
    readonly isReExport?: boolean
    readonly exportInfo?: SymbolExportInfo
    readonly moduleSpecifier: string
}
interface FixUseNamespaceImport extends ImportFixBase {
    readonly kind: ImportFixKind.UseNamespace
    readonly namespacePrefix: string
    readonly position: number
}
interface FixAddJsdocTypeImport extends ImportFixBase {
    readonly kind: ImportFixKind.JsdocTypeImport
    readonly position: number
    readonly isReExport: boolean
    readonly exportInfo: SymbolExportInfo
}
interface FixAddToExistingImport extends ImportFixBase {
    readonly kind: ImportFixKind.AddToExisting
    // readonly importClauseOrBindingPattern: ImportClause | ObjectBindingPattern
    // readonly importKind: ImportKind.Default | ImportKind.Named
    // readonly addAsTypeOnly: AddAsTypeOnly
}
interface FixAddNewImport extends ImportFixBase {
    readonly kind: ImportFixKind.AddNew
    // readonly importKind: ImportKind
    // readonly addAsTypeOnly: AddAsTypeOnly
    readonly useRequire: boolean
}
