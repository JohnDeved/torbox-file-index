import { Eta } from 'eta'

export interface RenderRow {
  name: string
}

export interface RenderTemplateData {
  title: string
  rowsHtml: string
}

const eta = new Eta({ autoEscape: true })

function dedent(input: string): string {
  const lines = input.replace(/^\n/, '').replace(/\s+$/, '').split('\n')
  const indents = lines
    .filter(line => line.trim().length > 0)
    .map(line => line.match(/^\s*/)![0].length)
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map(line => line.slice(minIndent)).join('\n')
}

const DIRECTORY_TEMPLATE = dedent(String.raw/* html */ `
  <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">
  <html>
   <head>
    <meta charset="utf-8">
    <title><%= it.title %></title>
   </head>
   <body>
    <h1><%= it.title %></h1>
  <pre>
  <%~ it.rowsHtml %>
  </pre>
   </body>
  </html>
`)

const compiled = eta.compile(DIRECTORY_TEMPLATE)

if (!compiled) throw new Error('Failed to compile directory template')

export function renderTemplate(data: RenderTemplateData): string {
  return compiled.call(eta, data)
}
