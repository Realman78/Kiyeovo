import { useSelector } from "react-redux";
import type { RootState } from "../../state/store";

type LogoProps = {
    version: "1" | "2";
    _isTorActive?: boolean
}

export const Logo = ({ version, _isTorActive }: LogoProps) => {
    const isTorActive = useSelector((state: RootState) => state.user.torEnabled);

    const fgColor = isTorActive || _isTorActive ? '#5a3184' : '#19d5e6';
    const bgColor = '#0b0e13';

    return <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 276 276"
    >
        <circle cx={138} cy={138} r={138} fill={bgColor} />
        <g fill={fgColor} shapeRendering="crispEdges" transform="translate(16 16)">
            <rect x={67} y={37} width={24} height={176} />
            <rect x={91} y={111} width={24} height={24} />
            <rect x={166} y={37} width={24} height={24} />
            <rect x={141} y={62} width={24} height={24} />
            <rect x={115} y={87} width={24} height={24} />
            <rect x={115} y={138} width={24} height={24} />
            <rect x={141} y={163} width={24} height={24} />
            <rect x={166} y={189} width={24} height={24} />
            {version === "2" && <>
                <rect x={67} y={111} width={24} height={24} fill={bgColor} />
                <rect x={67} y={62} width={24} height={24} fill={bgColor} />
                <rect x={67} y={163} width={24} height={24} fill={bgColor} />
            </>}
        </g>
    </svg>
}
