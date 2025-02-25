import fs from 'fs'
import { TextEdit, TextDocument, CancellationToken, Range, Position } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import ig from 'ignore';

import { IFormatterConfig } from '../common/types';
import { findWorkDirectory, findCommand, executeFile, checkAnyFileExists } from '../common/util';
import HunkStream from '../common/hunkStream';
import { relative, isAbsolute } from 'path';
import logger from '../common/logger';

type Handle = (text: string) => Promise<string>

async function handleFormat(
  config: IFormatterConfig,
  textDocument: TextDocument,
  text: string,
  next: Handle
): Promise<string | undefined> {
  const {
    command,
    rootPatterns = [],
    isStdout,
    isStderr,
    args = [],
    ignoreExitCode,
    ignore
  } = config
  const workDir = await findWorkDirectory(
    URI.parse(textDocument.uri).fsPath,
    rootPatterns
  )
  const currentFile = URI.parse(textDocument.uri).fsPath
  const relPath = relative(workDir, currentFile)

  try {
    // ignore file
    if (!isAbsolute(relPath) && ignore && ig().add(ignore).ignores(relPath)) {
      return next(text)
    }
  } catch (err) {
    logger.error(`ignore error: ${err.message || err.name || err}`)
  }

  if (config.requiredFiles && config.requiredFiles.length) {
    if (!checkAnyFileExists(workDir, config.requiredFiles)) {
      return next(text)
    }
  }

  const cmd = await findCommand(command, workDir)
  const {
    stdout = '',
    stderr = '',
    code
  } = await executeFile(
    new HunkStream(text),
    textDocument,
    cmd,
    args,
    {
      cwd: workDir
    }
    )
  let output = '';
  if (!ignoreExitCode && code > 0) {
    output = text
  } else if (code > 0 && ignoreExitCode instanceof Array && ignoreExitCode.indexOf(code) === -1) {
    output = text
  } else if (config.doesWriteToFile) {
    output = fs.readFileSync(URI.parse(textDocument.uri).fsPath, 'utf8')
  } else if (isStdout === undefined && isStderr === undefined) {
    output = stdout
  } else {
    if (isStdout) {
      output += stdout
    }
    if (isStderr) {
      output += stderr
    }
  }
  return next(output)
}


export async function formatDocument(
  formatterConfigs: IFormatterConfig[],
  textDocument: TextDocument,
  token: CancellationToken
): Promise<TextEdit[]> {

  const resolve = formatterConfigs
  .reverse()
  .reduce((res: Handle, config: IFormatterConfig) => {
    return async (text: string): Promise<string | undefined> => {
      if (token.isCancellationRequested) {
        return
      }
      return handleFormat(config, textDocument, text, res)
    }
  }, async (text: string) => text)

  const text = await resolve(textDocument.getText())

  if (!text) {
    return
  }

  return [{
    range: Range.create(
      Position.create(0, 0),
      Position.create(textDocument.lineCount + 1, 0)
    ),
    newText: text
  }]
}
