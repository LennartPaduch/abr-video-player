export const PlayerIcons = {
  createPlaySVG(width: string, height: string): SVGElement {
    const svgElement = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    );
    svgElement.setAttribute("width", width);
    svgElement.setAttribute("height", height);
    svgElement.setAttribute("viewBox", "0 0 24 24");

    const playPath = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    );
    playPath.setAttribute("d", "M8,5.14V19.14L19,12.14L8,5.14Z");
    playPath.setAttribute("fill", "white");

    svgElement.appendChild(playPath);
    return svgElement;
  },

  createPauseSVG(width: string, height: string): SVGElement {
    const svgElement = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    );
    svgElement.setAttribute("width", width);
    svgElement.setAttribute("height", height);
    svgElement.setAttribute("viewBox", "0 0 24 24");

    const pausePath = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    );
    pausePath.setAttribute("fill-rule", "evenodd");
    pausePath.setAttribute("clip-rule", "evenodd");
    pausePath.setAttribute(
      "d",
      "M4.5 3C4.22386 3 4 3.22386 4 3.5V20.5C4 20.7761 4.22386 21 4.5 21H9.5C9.77614 21 10 20.7761 10 20.5V3.5C10 3.22386 9.77614 3 9.5 3H4.5ZM14.5 3C14.2239 3 14 3.22386 14 3.5V20.5C14 20.7761 14.2239 21 14.5 21H19.5C19.7761 21 20 20.7761 20 20.5V3.5C20 3.22386 19.7761 3 19.5 3H14.5Z"
    );
    pausePath.setAttribute("fill", "white");

    svgElement.appendChild(pausePath);
    return svgElement;
  },

  createReplaySVG(width: string, height: string): SVGElement {
    const svgElement = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    );
    svgElement.setAttribute("width", width);
    svgElement.setAttribute("height", height);
    svgElement.setAttribute("viewBox", "0 0 24 24");

    // Create the circular arrow path
    const replayPath = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    );
    replayPath.setAttribute(
      "d",
      "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"
    );
    replayPath.setAttribute("fill", "white");

    svgElement.appendChild(replayPath);
    return svgElement;
  },
};
