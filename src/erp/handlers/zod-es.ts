import type { z } from 'zod'

// Mensajes de validación en español para los 422 `VALIDATION_ERROR` de los handlers (las apps
// son solo en español). Se pasa en cada `safeParse` (no cambia la configuración global de zod de
// la app). Los mensajes propios de un esquema (`.min(3, '…')`) tienen prioridad.

const TYPE_NAMES: Record<string, string> = {
  string: 'un texto',
  number: 'un número',
  int: 'un número entero',
  boolean: 'sí o no (boolean)',
  array: 'una lista',
  object: 'un objeto',
  date: 'una fecha',
  bigint: 'un número entero',
}

const FORMATS: Record<string, string> = {
  email: 'El correo no es válido',
  url: 'La URL no es válida',
  uuid: 'Debe ser un UUID',
  datetime: 'Debe ser una fecha y hora ISO 8601 (p. ej. 2026-09-25T12:00:00Z)',
  date: 'Debe ser una fecha AAAA-MM-DD',
  time: 'Debe ser una hora HH:MM',
}

const plural = (n: number | bigint, one: string, many: string) => (Number(n) === 1 ? one : many)

export const spanishErrorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined) return 'Campo obligatorio'
      if (issue.input === null) return 'No puede ser nulo'
      return `Debe ser ${TYPE_NAMES[issue.expected] ?? issue.expected}`
    case 'too_small': {
      const min = issue.minimum
      if (issue.origin === 'string') {
        if (Number(min) === 1) return 'No puede estar vacío'
        return issue.exact
          ? `Debe tener exactamente ${min} ${plural(min, 'carácter', 'caracteres')}`
          : `Debe tener al menos ${min} ${plural(min, 'carácter', 'caracteres')}`
      }
      if (issue.origin === 'array' || issue.origin === 'set') {
        return issue.exact ? `Debe tener exactamente ${min} ${plural(min, 'elemento', 'elementos')}` : `Debe tener al menos ${min} ${plural(min, 'elemento', 'elementos')}`
      }
      return issue.inclusive === false ? `Debe ser mayor que ${min}` : `Debe ser mayor o igual que ${min}`
    }
    case 'too_big': {
      const max = issue.maximum
      if (issue.origin === 'string') return `Debe tener como máximo ${max} ${plural(max, 'carácter', 'caracteres')}`
      if (issue.origin === 'array' || issue.origin === 'set') return `Debe tener como máximo ${max} ${plural(max, 'elemento', 'elementos')}`
      return issue.inclusive === false ? `Debe ser menor que ${max}` : `Debe ser menor o igual que ${max}`
    }
    case 'invalid_format':
      if (issue.format === 'regex') return 'El formato no es válido'
      return FORMATS[issue.format] ?? 'El formato no es válido'
    case 'not_multiple_of':
      return `Debe ser múltiplo de ${issue.divisor}`
    case 'unrecognized_keys':
      return `Campos no admitidos: ${issue.keys.join(', ')}`
    case 'invalid_union':
      return 'El valor no es válido'
    case 'invalid_value':
      return issue.values.length === 1
        ? `Debe ser ${JSON.stringify(issue.values[0])}`
        : `Debe ser uno de estos valores: ${issue.values.map((v) => String(v)).join(', ')}`
    case 'invalid_key':
      return 'Clave no válida'
    case 'invalid_element':
      return 'Elemento no válido'
    case 'custom':
      return 'El valor no es válido'
    default:
      return undefined
  }
}
