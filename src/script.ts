import { Player } from "./Player.js";
import { AssertConfig } from "./utils/assertion.js";

const title = "Sol Levante";
const manifestUrl = "/media/sollevante/dash/stream.mpd";
const bifUrl = "/bif/SolLevante-hd.bif";
const posterUrl = "/media/sollevante/poster/sollevante_poster.webp";

const player = new Player(title, manifestUrl, bifUrl, posterUrl);

AssertConfig.setEnabled(false);

window.onload = () => {
  player.startup();
};
