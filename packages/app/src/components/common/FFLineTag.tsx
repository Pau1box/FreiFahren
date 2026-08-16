import { ComponentProps } from 'react'

import { useLineColor } from '../../lines'
import { FFText, FFView } from './base'

type LineTagProps = {
    line: string | null | undefined
    textProps?: ComponentProps<typeof FFText>
} & ComponentProps<typeof FFView>

export const FFLineTag = ({ line, textProps, style, ...props }: LineTagProps) => {
    const lineColor = useLineColor()

    return (
        <FFView px="xxs" borderRadius="s" style={[{ backgroundColor: lineColor(line) }, style]} {...props}>
            <FFText color="fg" textAlign="center" variant="labelBold" {...textProps}>
                {line ?? ' ? '}
            </FFText>
        </FFView>
    )
}
