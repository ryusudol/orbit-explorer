//! SGP4 / SDP4 orbit propagation.
//!
//! Written from the model definition in Vallado, Crawford, Hujsak & Kelso,
//! "Revisiting Spacetrack Report #3" (AIAA 2006-6753), including every
//! `sgp4fix` correction from the 2020 revision. Variable names deliberately
//! follow the reference so each line can be checked against the paper.
//!
//! Units inside the model are Earth radii and minutes; the public API returns
//! TEME position in km and velocity in km/s.

use std::f64::consts::PI;

const TWOPI: f64 = 2.0 * PI;
const X2O3: f64 = 2.0 / 3.0;
/// Divide-by-zero guard for 180 deg inclination.
const TEMP4: f64 = 1.5e-12;

/// Gravity model constants. TLEs are fitted with WGS-72, so that is the default.
#[derive(Clone, Copy, Debug)]
pub struct Gravity {
    pub tumin: f64,
    pub mu: f64,
    pub radiusearthkm: f64,
    pub xke: f64,
    pub j2: f64,
    pub j3: f64,
    pub j4: f64,
    pub j3oj2: f64,
}

impl Gravity {
    pub fn wgs72() -> Self {
        let mu: f64 = 398600.8;
        let radiusearthkm = 6378.135;
        let xke = 60.0 / (radiusearthkm * radiusearthkm * radiusearthkm / mu).sqrt();
        let j2 = 0.001082616;
        let j3 = -0.00000253881;
        let j4 = -0.00000165597;
        Gravity { tumin: 1.0 / xke, mu, radiusearthkm, xke, j2, j3, j4, j3oj2: j3 / j2 }
    }

    pub fn wgs84() -> Self {
        let mu: f64 = 398600.5;
        let radiusearthkm = 6378.137;
        let xke = 60.0 / (radiusearthkm * radiusearthkm * radiusearthkm / mu).sqrt();
        let j2 = 0.00108262998905;
        let j3 = -0.00000253215306;
        let j4 = -0.00000161098761;
        Gravity { tumin: 1.0 / xke, mu, radiusearthkm, xke, j2, j3, j4, j3oj2: j3 / j2 }
    }
}

/// `Afspc` reproduces the operational AFSPC code; `Improved` uses the modern
/// sidereal time and the corrected node handling. Vallado's verification set
/// is generated in `Improved` mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpsMode {
    Afspc,
    Improved,
}

/// Mean orbital elements as published in a TLE / OMM, in conventional units.
#[derive(Clone, Copy, Debug, Default)]
pub struct Elements {
    pub norad_id: u32,
    /// Julian date (UTC) of the element epoch.
    pub epoch_jd: f64,
    /// Kozai mean motion, revolutions per day.
    pub mean_motion: f64,
    pub eccentricity: f64,
    pub inclination_deg: f64,
    pub raan_deg: f64,
    pub arg_perigee_deg: f64,
    pub mean_anomaly_deg: f64,
    /// Drag term, 1 / Earth radii.
    pub bstar: f64,
    /// First derivative of mean motion / 2, rev/day^2 (informational; SGP4 ignores it).
    pub ndot: f64,
    /// Second derivative of mean motion / 6, rev/day^3 (informational).
    pub nddot: f64,
}

/// Error codes match the reference implementation.
pub mod error {
    pub const OK: u8 = 0;
    pub const ECCENTRICITY: u8 = 1;
    pub const MEAN_MOTION: u8 = 2;
    pub const PERTURBED_ECCENTRICITY: u8 = 3;
    pub const SEMI_LATUS_RECTUM: u8 = 4;
    pub const DECAYED: u8 = 6;
}

/// Propagator state for one object (the reference's `elsetrec`).
#[derive(Clone, Debug, Default)]
pub struct Satrec {
    pub satnum: u32,
    pub epoch_jd: f64,
    pub error: u8,
    pub opsmode_afspc: bool,
    init: bool,
    pub deep_space: bool,
    isimp: bool,

    // near earth
    aycof: f64,
    con41: f64,
    cc1: f64,
    cc4: f64,
    cc5: f64,
    d2: f64,
    d3: f64,
    d4: f64,
    delmo: f64,
    eta: f64,
    argpdot: f64,
    omgcof: f64,
    sinmao: f64,
    t: f64,
    t2cof: f64,
    t3cof: f64,
    t4cof: f64,
    t5cof: f64,
    x1mth2: f64,
    x7thm1: f64,
    mdot: f64,
    nodedot: f64,
    xlcof: f64,
    xmcof: f64,
    nodecf: f64,

    // deep space
    irez: i32,
    d2201: f64,
    d2211: f64,
    d3210: f64,
    d3222: f64,
    d4410: f64,
    d4422: f64,
    d5220: f64,
    d5232: f64,
    d5421: f64,
    d5433: f64,
    dedt: f64,
    del1: f64,
    del2: f64,
    del3: f64,
    didt: f64,
    dmdt: f64,
    dnodt: f64,
    domdt: f64,
    e3: f64,
    ee2: f64,
    peo: f64,
    pgho: f64,
    pho: f64,
    pinco: f64,
    plo: f64,
    se2: f64,
    se3: f64,
    sgh2: f64,
    sgh3: f64,
    sgh4: f64,
    sh2: f64,
    sh3: f64,
    si2: f64,
    si3: f64,
    sl2: f64,
    sl3: f64,
    sl4: f64,
    pub gsto: f64,
    xfact: f64,
    xgh2: f64,
    xgh3: f64,
    xgh4: f64,
    xh2: f64,
    xh3: f64,
    xi2: f64,
    xi3: f64,
    xl2: f64,
    xl3: f64,
    xl4: f64,
    xlamo: f64,
    zmol: f64,
    zmos: f64,
    atime: f64,
    xli: f64,
    xni: f64,

    // elements (radians, radians/minute)
    pub a: f64,
    pub altp: f64,
    pub alta: f64,
    pub bstar: f64,
    pub inclo: f64,
    pub nodeo: f64,
    pub ecco: f64,
    pub argpo: f64,
    pub mo: f64,
    pub no_kozai: f64,
    pub no_unkozai: f64,

    grav: GravityFields,

    /// Singly averaged mean elements from the last `propagate` call.
    pub am: f64,
    pub em: f64,
    pub im: f64,
    pub om_node: f64,
    pub om_argp: f64,
    pub mm: f64,
    pub nm: f64,
}

#[derive(Clone, Copy, Debug, Default)]
struct GravityFields {
    tumin: f64,
    radiusearthkm: f64,
    xke: f64,
    j2: f64,
    j4: f64,
    j3oj2: f64,
}

/// Outputs of `dscom` (lunar/solar common terms).
#[derive(Default)]
struct DsCom {
    snodm: f64,
    cnodm: f64,
    sinim: f64,
    cosim: f64,
    sinomm: f64,
    cosomm: f64,
    day: f64,
    em: f64,
    emsq: f64,
    gam: f64,
    rtemsq: f64,
    s1: f64,
    s2: f64,
    s3: f64,
    s4: f64,
    s5: f64,
    s6: f64,
    s7: f64,
    ss1: f64,
    ss2: f64,
    ss3: f64,
    ss4: f64,
    ss5: f64,
    ss6: f64,
    ss7: f64,
    sz1: f64,
    sz2: f64,
    sz3: f64,
    sz11: f64,
    sz12: f64,
    sz13: f64,
    sz21: f64,
    sz22: f64,
    sz23: f64,
    sz31: f64,
    sz32: f64,
    sz33: f64,
    nm: f64,
    z1: f64,
    z2: f64,
    z3: f64,
    z11: f64,
    z12: f64,
    z13: f64,
    z21: f64,
    z22: f64,
    z23: f64,
    z31: f64,
    z32: f64,
    z33: f64,
}

/// Greenwich mean sidereal time (IAU-82), radians. `jdut1` is a full Julian date.
pub fn gstime(jdut1: f64) -> f64 {
    let tut1 = (jdut1 - 2451545.0) / 36525.0;
    let mut temp = -6.2e-6 * tut1 * tut1 * tut1
        + 0.093104 * tut1 * tut1
        + (876600.0 * 3600.0 + 8640184.812866) * tut1
        + 67310.54841; // seconds
    temp = (temp * (PI / 180.0) / 240.0) % TWOPI; // 360/86400 = 1/240
    if temp < 0.0 {
        temp += TWOPI;
    }
    temp
}

impl Satrec {
    /// Initialise the propagator from mean elements (the reference's `sgp4init`).
    pub fn new(el: &Elements, grav: Gravity, opsmode: OpsMode) -> Satrec {
        let deg2rad = PI / 180.0;
        let xpdotp = 1440.0 / (2.0 * PI); // 229.1831180523293

        let mut s = Satrec {
            satnum: el.norad_id,
            epoch_jd: el.epoch_jd,
            opsmode_afspc: opsmode == OpsMode::Afspc,
            bstar: el.bstar,
            ecco: el.eccentricity,
            argpo: el.arg_perigee_deg * deg2rad,
            inclo: el.inclination_deg * deg2rad,
            mo: el.mean_anomaly_deg * deg2rad,
            no_kozai: el.mean_motion / xpdotp,
            nodeo: el.raan_deg * deg2rad,
            grav: GravityFields {
                tumin: grav.tumin,
                radiusearthkm: grav.radiusearthkm,
                xke: grav.xke,
                j2: grav.j2,
                j4: grav.j4,
                j3oj2: grav.j3oj2,
            },
            ..Default::default()
        };
        s.sgp4init(el.epoch_jd - 2433281.5);
        s
    }

    /// `epoch` is days since 1950 Jan 0.0 UTC, as in the reference.
    fn sgp4init(&mut self, epoch: f64) {
        let g = self.grav;
        let ss = 78.0 / g.radiusearthkm + 1.0;
        let qzms2ttemp = (120.0 - 78.0) / g.radiusearthkm;
        let qzms2t = qzms2ttemp * qzms2ttemp * qzms2ttemp * qzms2ttemp;

        self.init = true;
        self.t = 0.0;

        // ------------------------------ initl ------------------------------
        let eccsq = self.ecco * self.ecco;
        let omeosq = 1.0 - eccsq;
        let rteosq = omeosq.sqrt();
        let cosio = self.inclo.cos();
        let cosio2 = cosio * cosio;

        // un-kozai the mean motion
        let ak = (g.xke / self.no_kozai).powf(X2O3);
        let d1 = 0.75 * g.j2 * (3.0 * cosio2 - 1.0) / (rteosq * omeosq);
        let mut del = d1 / (ak * ak);
        let adel = ak * (1.0 - del * del - del * (1.0 / 3.0 + 134.0 * del * del / 81.0));
        del = d1 / (adel * adel);
        self.no_unkozai = self.no_kozai / (1.0 + del);

        let ao = (g.xke / self.no_unkozai).powf(X2O3);
        let sinio = self.inclo.sin();
        let po = ao * omeosq;
        let con42 = 1.0 - 5.0 * cosio2;
        self.con41 = -con42 - cosio2 - cosio2;
        let posq = po * po;
        let rp = ao * (1.0 - self.ecco);

        self.gsto = if self.opsmode_afspc {
            // AFSPC: the old 1970-referenced sidereal time
            let ts70 = epoch - 7305.0;
            let ds70 = (ts70 + 1.0e-8).floor();
            let tfrac = ts70 - ds70;
            let c1 = 1.72027916940703639e-2;
            let thgr70 = 1.7321343856509374;
            let fk5r = 5.07551419432269442e-15;
            let c1p2p = c1 + TWOPI;
            let mut gsto = (thgr70 + c1 * ds70 + c1p2p * tfrac + ts70 * ts70 * fk5r) % TWOPI;
            if gsto < 0.0 {
                gsto += TWOPI;
            }
            gsto
        } else {
            gstime(epoch + 2433281.5)
        };
        // ---------------------------- end initl ----------------------------

        self.a = (self.no_unkozai * g.tumin).powf(-2.0 / 3.0);
        self.alta = self.a * (1.0 + self.ecco) - 1.0;
        self.altp = self.a * (1.0 - self.ecco) - 1.0;
        self.error = error::OK;

        if omeosq >= 0.0 || self.no_unkozai >= 0.0 {
            self.isimp = rp < (220.0 / g.radiusearthkm + 1.0);
            let mut sfour = ss;
            let mut qzms24 = qzms2t;
            let perige = (rp - 1.0) * g.radiusearthkm;

            // for perigees below 156 km, s and qoms2t are altered
            if perige < 156.0 {
                sfour = perige - 78.0;
                if perige < 98.0 {
                    sfour = 20.0;
                }
                let qzms24temp = (120.0 - sfour) / g.radiusearthkm;
                qzms24 = qzms24temp * qzms24temp * qzms24temp * qzms24temp;
                sfour = sfour / g.radiusearthkm + 1.0;
            }
            let pinvsq = 1.0 / posq;

            let tsi = 1.0 / (ao - sfour);
            self.eta = ao * self.ecco * tsi;
            let etasq = self.eta * self.eta;
            let eeta = self.ecco * self.eta;
            let psisq = (1.0 - etasq).abs();
            let coef = qzms24 * tsi.powi(4);
            let coef1 = coef / psisq.powf(3.5);
            let cc2 = coef1
                * self.no_unkozai
                * (ao * (1.0 + 1.5 * etasq + eeta * (4.0 + etasq))
                    + 0.375 * g.j2 * tsi / psisq * self.con41 * (8.0 + 3.0 * etasq * (8.0 + etasq)));
            self.cc1 = self.bstar * cc2;
            let mut cc3 = 0.0;
            if self.ecco > 1.0e-4 {
                cc3 = -2.0 * coef * tsi * g.j3oj2 * self.no_unkozai * sinio / self.ecco;
            }
            self.x1mth2 = 1.0 - cosio2;
            self.cc4 = 2.0
                * self.no_unkozai
                * coef1
                * ao
                * omeosq
                * (self.eta * (2.0 + 0.5 * etasq) + self.ecco * (0.5 + 2.0 * etasq)
                    - g.j2 * tsi / (ao * psisq)
                        * (-3.0 * self.con41 * (1.0 - 2.0 * eeta + etasq * (1.5 - 0.5 * eeta))
                            + 0.75 * self.x1mth2 * (2.0 * etasq - eeta * (1.0 + etasq)) * (2.0 * self.argpo).cos()));
            self.cc5 = 2.0 * coef1 * ao * omeosq * (1.0 + 2.75 * (etasq + eeta) + eeta * etasq);
            let cosio4 = cosio2 * cosio2;
            let temp1 = 1.5 * g.j2 * pinvsq * self.no_unkozai;
            let temp2 = 0.5 * temp1 * g.j2 * pinvsq;
            let temp3 = -0.46875 * g.j4 * pinvsq * pinvsq * self.no_unkozai;
            self.mdot = self.no_unkozai
                + 0.5 * temp1 * rteosq * self.con41
                + 0.0625 * temp2 * rteosq * (13.0 - 78.0 * cosio2 + 137.0 * cosio4);
            self.argpdot = -0.5 * temp1 * con42
                + 0.0625 * temp2 * (7.0 - 114.0 * cosio2 + 395.0 * cosio4)
                + temp3 * (3.0 - 36.0 * cosio2 + 49.0 * cosio4);
            let xhdot1 = -temp1 * cosio;
            self.nodedot = xhdot1 + (0.5 * temp2 * (4.0 - 19.0 * cosio2) + 2.0 * temp3 * (3.0 - 7.0 * cosio2)) * cosio;
            let xpidot = self.argpdot + self.nodedot;
            self.omgcof = self.bstar * cc3 * self.argpo.cos();
            self.xmcof = 0.0;
            if self.ecco > 1.0e-4 {
                self.xmcof = -X2O3 * coef * self.bstar / eeta;
            }
            self.nodecf = 3.5 * omeosq * xhdot1 * self.cc1;
            self.t2cof = 1.5 * self.cc1;
            // sgp4fix for divide by zero with xinco = 180 deg
            self.xlcof = if (cosio + 1.0).abs() > 1.5e-12 {
                -0.25 * g.j3oj2 * sinio * (3.0 + 5.0 * cosio) / (1.0 + cosio)
            } else {
                -0.25 * g.j3oj2 * sinio * (3.0 + 5.0 * cosio) / TEMP4
            };
            self.aycof = -0.5 * g.j3oj2 * sinio;
            let delmotemp = 1.0 + self.eta * self.mo.cos();
            self.delmo = delmotemp * delmotemp * delmotemp;
            self.sinmao = self.mo.sin();
            self.x7thm1 = 7.0 * cosio2 - 1.0;

            // --------------------- deep space initialization ---------------------
            if (2.0 * PI / self.no_unkozai) >= 225.0 {
                self.deep_space = true;
                self.isimp = true;
                let tc = 0.0;
                let inclm = self.inclo;

                let ds = self.dscom(epoch, self.ecco, self.argpo, tc, self.inclo, self.nodeo, self.no_unkozai);
                // dpper is a no-op while init is set, so the reference call here is omitted.

                let mut em = ds.em;
                let mut argpm = 0.0;
                let mut inclm_mut = inclm;
                let mut mm = 0.0;
                let mut nm = ds.nm;
                let mut nodem = 0.0;
                self.dsinit(
                    &ds, self.t, tc, xpidot, eccsq, &mut em, &mut argpm, &mut inclm_mut, &mut mm, &mut nm, &mut nodem,
                );
            }

            // ------------------- set variables if not deep space -------------------
            if !self.isimp {
                let cc1sq = self.cc1 * self.cc1;
                self.d2 = 4.0 * ao * tsi * cc1sq;
                let temp = self.d2 * tsi * self.cc1 / 3.0;
                self.d3 = (17.0 * ao + sfour) * temp;
                self.d4 = 0.5 * temp * ao * tsi * (221.0 * ao + 31.0 * sfour) * self.cc1;
                self.t3cof = self.d2 + 2.0 * cc1sq;
                self.t4cof = 0.25 * (3.0 * self.d3 + self.cc1 * (12.0 * self.d2 + 10.0 * cc1sq));
                self.t5cof = 0.2
                    * (3.0 * self.d4 + 12.0 * self.cc1 * self.d3 + 6.0 * self.d2 * self.d2 + 15.0 * cc1sq * (2.0 * self.d2 + cc1sq));
            }
        }

        // propagate to zero epoch to initialise the remaining state
        let _ = self.propagate(0.0);
        self.init = false;
    }

    /// Lunar/solar common terms.
    #[allow(clippy::too_many_arguments)]
    fn dscom(&mut self, epoch: f64, ep: f64, argpp: f64, tc: f64, inclp: f64, nodep: f64, np: f64) -> DsCom {
        const ZES: f64 = 0.01675;
        const ZEL: f64 = 0.05490;
        const C1SS: f64 = 2.9864797e-6;
        const C1L: f64 = 4.7968065e-7;
        const ZSINIS: f64 = 0.39785416;
        const ZCOSIS: f64 = 0.91744867;
        const ZCOSGS: f64 = 0.1945905;
        const ZSINGS: f64 = -0.98088458;

        let mut d = DsCom { nm: np, em: ep, ..Default::default() };
        d.snodm = nodep.sin();
        d.cnodm = nodep.cos();
        d.sinomm = argpp.sin();
        d.cosomm = argpp.cos();
        d.sinim = inclp.sin();
        d.cosim = inclp.cos();
        d.emsq = d.em * d.em;
        let betasq = 1.0 - d.emsq;
        d.rtemsq = betasq.sqrt();

        // initialize lunar solar terms
        self.peo = 0.0;
        self.pinco = 0.0;
        self.plo = 0.0;
        self.pgho = 0.0;
        self.pho = 0.0;
        d.day = epoch + 18261.5 + tc / 1440.0;
        let xnodce = (4.5236020 - 9.2422029e-4 * d.day) % TWOPI;
        let stem = xnodce.sin();
        let ctem = xnodce.cos();
        let zcosil = 0.91375164 - 0.03568096 * ctem;
        let zsinil = (1.0 - zcosil * zcosil).sqrt();
        let zsinhl = 0.089683511 * stem / zsinil;
        let zcoshl = (1.0 - zsinhl * zsinhl).sqrt();
        d.gam = 5.8351514 + 0.0019443680 * d.day;
        let mut zx = 0.39785416 * stem / zsinil;
        let zy = zcoshl * ctem + 0.91744867 * zsinhl * stem;
        zx = zx.atan2(zy);
        zx = d.gam + zx - xnodce;
        let zcosgl = zx.cos();
        let zsingl = zx.sin();

        // do solar terms
        let mut zcosg = ZCOSGS;
        let mut zsing = ZSINGS;
        let mut zcosi = ZCOSIS;
        let mut zsini = ZSINIS;
        let mut zcosh = d.cnodm;
        let mut zsinh = d.snodm;
        let mut cc = C1SS;
        let xnoi = 1.0 / d.nm;

        for lsflg in 1..=2 {
            let a1 = zcosg * zcosh + zsing * zcosi * zsinh;
            let a3 = -zsing * zcosh + zcosg * zcosi * zsinh;
            let a7 = -zcosg * zsinh + zsing * zcosi * zcosh;
            let a8 = zsing * zsini;
            let a9 = zsing * zsinh + zcosg * zcosi * zcosh;
            let a10 = zcosg * zsini;
            let a2 = d.cosim * a7 + d.sinim * a8;
            let a4 = d.cosim * a9 + d.sinim * a10;
            let a5 = -d.sinim * a7 + d.cosim * a8;
            let a6 = -d.sinim * a9 + d.cosim * a10;

            let x1 = a1 * d.cosomm + a2 * d.sinomm;
            let x2 = a3 * d.cosomm + a4 * d.sinomm;
            let x3 = -a1 * d.sinomm + a2 * d.cosomm;
            let x4 = -a3 * d.sinomm + a4 * d.cosomm;
            let x5 = a5 * d.sinomm;
            let x6 = a6 * d.sinomm;
            let x7 = a5 * d.cosomm;
            let x8 = a6 * d.cosomm;

            d.z31 = 12.0 * x1 * x1 - 3.0 * x3 * x3;
            d.z32 = 24.0 * x1 * x2 - 6.0 * x3 * x4;
            d.z33 = 12.0 * x2 * x2 - 3.0 * x4 * x4;
            d.z1 = 3.0 * (a1 * a1 + a2 * a2) + d.z31 * d.emsq;
            d.z2 = 6.0 * (a1 * a3 + a2 * a4) + d.z32 * d.emsq;
            d.z3 = 3.0 * (a3 * a3 + a4 * a4) + d.z33 * d.emsq;
            d.z11 = -6.0 * a1 * a5 + d.emsq * (-24.0 * x1 * x7 - 6.0 * x3 * x5);
            d.z12 = -6.0 * (a1 * a6 + a3 * a5) + d.emsq * (-24.0 * (x2 * x7 + x1 * x8) - 6.0 * (x3 * x6 + x4 * x5));
            d.z13 = -6.0 * a3 * a6 + d.emsq * (-24.0 * x2 * x8 - 6.0 * x4 * x6);
            d.z21 = 6.0 * a2 * a5 + d.emsq * (24.0 * x1 * x5 - 6.0 * x3 * x7);
            d.z22 = 6.0 * (a4 * a5 + a2 * a6) + d.emsq * (24.0 * (x2 * x5 + x1 * x6) - 6.0 * (x4 * x7 + x3 * x8));
            d.z23 = 6.0 * a4 * a6 + d.emsq * (24.0 * x2 * x6 - 6.0 * x4 * x8);
            d.z1 = d.z1 + d.z1 + betasq * d.z31;
            d.z2 = d.z2 + d.z2 + betasq * d.z32;
            d.z3 = d.z3 + d.z3 + betasq * d.z33;
            d.s3 = cc * xnoi;
            d.s2 = -0.5 * d.s3 / d.rtemsq;
            d.s4 = d.s3 * d.rtemsq;
            d.s1 = -15.0 * d.em * d.s4;
            d.s5 = x1 * x3 + x2 * x4;
            d.s6 = x2 * x3 + x1 * x4;
            d.s7 = x2 * x4 - x1 * x3;

            // do lunar terms
            if lsflg == 1 {
                d.ss1 = d.s1;
                d.ss2 = d.s2;
                d.ss3 = d.s3;
                d.ss4 = d.s4;
                d.ss5 = d.s5;
                d.ss6 = d.s6;
                d.ss7 = d.s7;
                d.sz1 = d.z1;
                d.sz2 = d.z2;
                d.sz3 = d.z3;
                d.sz11 = d.z11;
                d.sz12 = d.z12;
                d.sz13 = d.z13;
                d.sz21 = d.z21;
                d.sz22 = d.z22;
                d.sz23 = d.z23;
                d.sz31 = d.z31;
                d.sz32 = d.z32;
                d.sz33 = d.z33;
                zcosg = zcosgl;
                zsing = zsingl;
                zcosi = zcosil;
                zsini = zsinil;
                zcosh = zcoshl * d.cnodm + zsinhl * d.snodm;
                zsinh = d.snodm * zcoshl - d.cnodm * zsinhl;
                cc = C1L;
            }
        }

        self.zmol = (4.7199672 + 0.22997150 * d.day - d.gam) % TWOPI;
        self.zmos = (6.2565837 + 0.017201977 * d.day) % TWOPI;

        // solar terms
        self.se2 = 2.0 * d.ss1 * d.ss6;
        self.se3 = 2.0 * d.ss1 * d.ss7;
        self.si2 = 2.0 * d.ss2 * d.sz12;
        self.si3 = 2.0 * d.ss2 * (d.sz13 - d.sz11);
        self.sl2 = -2.0 * d.ss3 * d.sz2;
        self.sl3 = -2.0 * d.ss3 * (d.sz3 - d.sz1);
        self.sl4 = -2.0 * d.ss3 * (-21.0 - 9.0 * d.emsq) * ZES;
        self.sgh2 = 2.0 * d.ss4 * d.sz32;
        self.sgh3 = 2.0 * d.ss4 * (d.sz33 - d.sz31);
        self.sgh4 = -18.0 * d.ss4 * ZES;
        self.sh2 = -2.0 * d.ss2 * d.sz22;
        self.sh3 = -2.0 * d.ss2 * (d.sz23 - d.sz21);

        // lunar terms
        self.ee2 = 2.0 * d.s1 * d.s6;
        self.e3 = 2.0 * d.s1 * d.s7;
        self.xi2 = 2.0 * d.s2 * d.z12;
        self.xi3 = 2.0 * d.s2 * (d.z13 - d.z11);
        self.xl2 = -2.0 * d.s3 * d.z2;
        self.xl3 = -2.0 * d.s3 * (d.z3 - d.z1);
        self.xl4 = -2.0 * d.s3 * (-21.0 - 9.0 * d.emsq) * ZEL;
        self.xgh2 = 2.0 * d.s4 * d.z32;
        self.xgh3 = 2.0 * d.s4 * (d.z33 - d.z31);
        self.xgh4 = -18.0 * d.s4 * ZEL;
        self.xh2 = -2.0 * d.s2 * d.z22;
        self.xh3 = -2.0 * d.s2 * (d.z23 - d.z21);

        d
    }

    /// Lunar/solar periodics applied to the mean elements (`dpper`, init = 'n').
    fn dpper(&self, t: f64, ep: &mut f64, inclp: &mut f64, nodep: &mut f64, argpp: &mut f64, mp: &mut f64) {
        const ZNS: f64 = 1.19459e-5;
        const ZES: f64 = 0.01675;
        const ZNL: f64 = 1.5835218e-4;
        const ZEL: f64 = 0.05490;

        // time varying periodics
        let mut zm = self.zmos + ZNS * t;
        if self.init {
            zm = self.zmos;
        }
        let mut zf = zm + 2.0 * ZES * zm.sin();
        let mut sinzf = zf.sin();
        let mut f2 = 0.5 * sinzf * sinzf - 0.25;
        let mut f3 = -0.5 * sinzf * zf.cos();
        let ses = self.se2 * f2 + self.se3 * f3;
        let sis = self.si2 * f2 + self.si3 * f3;
        let sls = self.sl2 * f2 + self.sl3 * f3 + self.sl4 * sinzf;
        let sghs = self.sgh2 * f2 + self.sgh3 * f3 + self.sgh4 * sinzf;
        let shs = self.sh2 * f2 + self.sh3 * f3;
        zm = self.zmol + ZNL * t;
        if self.init {
            zm = self.zmol;
        }
        zf = zm + 2.0 * ZEL * zm.sin();
        sinzf = zf.sin();
        f2 = 0.5 * sinzf * sinzf - 0.25;
        f3 = -0.5 * sinzf * zf.cos();
        let sel = self.ee2 * f2 + self.e3 * f3;
        let sil = self.xi2 * f2 + self.xi3 * f3;
        let sll = self.xl2 * f2 + self.xl3 * f3 + self.xl4 * sinzf;
        let sghl = self.xgh2 * f2 + self.xgh3 * f3 + self.xgh4 * sinzf;
        let shll = self.xh2 * f2 + self.xh3 * f3;
        let mut pe = ses + sel;
        let mut pinc = sis + sil;
        let mut pl = sls + sll;
        let mut pgh = sghs + sghl;
        let mut ph = shs + shll;

        // `sgp4` always calls dpper with init = 'n'
        pe -= self.peo;
        pinc -= self.pinco;
        pl -= self.plo;
        pgh -= self.pgho;
        ph -= self.pho;
        *inclp += pinc;
        *ep += pe;
        let sinip = inclp.sin();
        let cosip = inclp.cos();

        // sgp4fix: gsfc version uses the perturbed inclination for the Lyddane switch
        if *inclp >= 0.2 {
            ph /= sinip;
            pgh -= cosip * ph;
            *argpp += pgh;
            *nodep += ph;
            *mp += pl;
        } else {
            // apply periodics with Lyddane modification
            let sinop = nodep.sin();
            let cosop = nodep.cos();
            let mut alfdp = sinip * sinop;
            let mut betdp = sinip * cosop;
            let dalf = ph * cosop + pinc * cosip * sinop;
            let dbet = -ph * sinop + pinc * cosip * cosop;
            alfdp += dalf;
            betdp += dbet;
            *nodep %= TWOPI;
            if *nodep < 0.0 && self.opsmode_afspc {
                *nodep += TWOPI;
            }
            let mut xls = *mp + *argpp + cosip * *nodep;
            let dls = pl + pgh - pinc * *nodep * sinip;
            xls += dls;
            let xnoh = *nodep;
            *nodep = alfdp.atan2(betdp);
            if *nodep < 0.0 && self.opsmode_afspc {
                *nodep += TWOPI;
            }
            if (xnoh - *nodep).abs() > PI {
                if *nodep < xnoh {
                    *nodep += TWOPI;
                } else {
                    *nodep -= TWOPI;
                }
            }
            *mp += pl;
            *argpp = xls - *mp - cosip * *nodep;
        }
    }

    /// Deep-space secular rates and resonance setup.
    #[allow(clippy::too_many_arguments, unused_assignments)]
    fn dsinit(
        &mut self,
        ds: &DsCom,
        t: f64,
        tc: f64,
        xpidot: f64,
        eccsq: f64,
        em: &mut f64,
        argpm: &mut f64,
        inclm: &mut f64,
        mm: &mut f64,
        nm: &mut f64,
        nodem: &mut f64,
    ) {
        let q22 = 1.7891679e-6;
        let q31 = 2.1460748e-6;
        let q33 = 2.2123015e-7;
        let root22 = 1.7891679e-6;
        let root44 = 7.3636953e-9;
        let root54 = 2.1765803e-9;
        let rptim = 4.37526908801129966e-3; // 7.29211514668855e-5 rad/s
        let root32 = 3.7393792e-7;
        let root52 = 1.1428639e-7;
        let znl = 1.5835218e-4;
        let zns = 1.19459e-5;
        let xke = self.grav.xke;

        let cosim = ds.cosim;
        let sinim = ds.sinim;
        let mut emsq = ds.emsq;

        // deep space initialization
        self.irez = 0;
        if *nm < 0.0052359877 && *nm > 0.0034906585 {
            self.irez = 1;
        }
        if (8.26e-3..=9.24e-3).contains(nm) && *em >= 0.5 {
            self.irez = 2;
        }

        // solar terms
        let ses = ds.ss1 * zns * ds.ss5;
        let sis = ds.ss2 * zns * (ds.sz11 + ds.sz13);
        let sls = -zns * ds.ss3 * (ds.sz1 + ds.sz3 - 14.0 - 6.0 * emsq);
        let sghs = ds.ss4 * zns * (ds.sz31 + ds.sz33 - 6.0);
        let mut shs = -zns * ds.ss2 * (ds.sz21 + ds.sz23);
        // sgp4fix for 180 deg incl
        if *inclm < 5.2359877e-2 || *inclm > PI - 5.2359877e-2 {
            shs = 0.0;
        }
        if sinim != 0.0 {
            shs /= sinim;
        }
        let sgs = sghs - cosim * shs;

        // lunar terms
        self.dedt = ses + ds.s1 * znl * ds.s5;
        self.didt = sis + ds.s2 * znl * (ds.z11 + ds.z13);
        self.dmdt = sls - znl * ds.s3 * (ds.z1 + ds.z3 - 14.0 - 6.0 * emsq);
        let sghl = ds.s4 * znl * (ds.z31 + ds.z33 - 6.0);
        let mut shll = -znl * ds.s2 * (ds.z21 + ds.z23);
        if *inclm < 5.2359877e-2 || *inclm > PI - 5.2359877e-2 {
            shll = 0.0;
        }
        self.domdt = sgs + sghl;
        self.dnodt = shs;
        if sinim != 0.0 {
            self.domdt -= cosim / sinim * shll;
            self.dnodt += shll / sinim;
        }

        // deep space resonance effects
        let dndt = 0.0;
        let theta = (self.gsto + tc * rptim) % TWOPI;
        *em += self.dedt * t;
        *inclm += self.didt * t;
        *argpm += self.domdt * t;
        *nodem += self.dnodt * t;
        *mm += self.dmdt * t;

        if self.irez != 0 {
            let aonv = (*nm / xke).powf(X2O3);

            // geopotential resonance for 12 hour orbits
            if self.irez == 2 {
                let cosisq = cosim * cosim;
                let emo = *em;
                *em = self.ecco;
                let emsqo = emsq;
                emsq = eccsq;
                let eoc = *em * emsq;
                let g201 = -0.306 - (*em - 0.64) * 0.440;

                let (g211, g310, g322, g410, g422, g520);
                if *em <= 0.65 {
                    g211 = 3.616 - 13.2470 * *em + 16.2900 * emsq;
                    g310 = -19.302 + 117.3900 * *em - 228.4190 * emsq + 156.5910 * eoc;
                    g322 = -18.9068 + 109.7927 * *em - 214.6334 * emsq + 146.5816 * eoc;
                    g410 = -41.122 + 242.6940 * *em - 471.0940 * emsq + 313.9530 * eoc;
                    g422 = -146.407 + 841.8800 * *em - 1629.014 * emsq + 1083.4350 * eoc;
                    g520 = -532.114 + 3017.977 * *em - 5740.032 * emsq + 3708.2760 * eoc;
                } else {
                    g211 = -72.099 + 331.819 * *em - 508.738 * emsq + 266.724 * eoc;
                    g310 = -346.844 + 1582.851 * *em - 2415.925 * emsq + 1246.113 * eoc;
                    g322 = -342.585 + 1554.908 * *em - 2366.899 * emsq + 1215.972 * eoc;
                    g410 = -1052.797 + 4758.686 * *em - 7193.992 * emsq + 3651.957 * eoc;
                    g422 = -3581.690 + 16178.110 * *em - 24462.770 * emsq + 12422.520 * eoc;
                    g520 = if *em > 0.715 {
                        -5149.66 + 29936.92 * *em - 54087.36 * emsq + 31324.56 * eoc
                    } else {
                        1464.74 - 4664.75 * *em + 3763.64 * emsq
                    };
                }
                let (g533, g521, g532);
                if *em < 0.7 {
                    g533 = -919.22770 + 4988.6100 * *em - 9064.7700 * emsq + 5542.21 * eoc;
                    g521 = -822.71072 + 4568.6173 * *em - 8491.4146 * emsq + 5337.524 * eoc;
                    g532 = -853.66600 + 4690.2500 * *em - 8624.7700 * emsq + 5341.4 * eoc;
                } else {
                    g533 = -37995.780 + 161616.52 * *em - 229838.20 * emsq + 109377.94 * eoc;
                    g521 = -51752.104 + 218913.95 * *em - 309468.16 * emsq + 146349.42 * eoc;
                    g532 = -40023.880 + 170470.89 * *em - 242699.48 * emsq + 115605.82 * eoc;
                }

                let sini2 = sinim * sinim;
                let f220 = 0.75 * (1.0 + 2.0 * cosim + cosisq);
                let f221 = 1.5 * sini2;
                let f321 = 1.875 * sinim * (1.0 - 2.0 * cosim - 3.0 * cosisq);
                let f322 = -1.875 * sinim * (1.0 + 2.0 * cosim - 3.0 * cosisq);
                let f441 = 35.0 * sini2 * f220;
                let f442 = 39.3750 * sini2 * sini2;
                let f522 = 9.84375
                    * sinim
                    * (sini2 * (1.0 - 2.0 * cosim - 5.0 * cosisq) + 0.33333333 * (-2.0 + 4.0 * cosim + 6.0 * cosisq));
                let f523 = sinim
                    * (4.92187512 * sini2 * (-2.0 - 4.0 * cosim + 10.0 * cosisq)
                        + 6.56250012 * (1.0 + 2.0 * cosim - 3.0 * cosisq));
                let f542 = 29.53125 * sinim * (2.0 - 8.0 * cosim + cosisq * (-12.0 + 8.0 * cosim + 10.0 * cosisq));
                let f543 = 29.53125 * sinim * (-2.0 - 8.0 * cosim + cosisq * (12.0 + 8.0 * cosim - 10.0 * cosisq));
                let xno2 = *nm * *nm;
                let ainv2 = aonv * aonv;
                let mut temp1 = 3.0 * xno2 * ainv2;
                let mut temp = temp1 * root22;
                self.d2201 = temp * f220 * g201;
                self.d2211 = temp * f221 * g211;
                temp1 *= aonv;
                temp = temp1 * root32;
                self.d3210 = temp * f321 * g310;
                self.d3222 = temp * f322 * g322;
                temp1 *= aonv;
                temp = 2.0 * temp1 * root44;
                self.d4410 = temp * f441 * g410;
                self.d4422 = temp * f442 * g422;
                temp1 *= aonv;
                temp = temp1 * root52;
                self.d5220 = temp * f522 * g520;
                self.d5232 = temp * f523 * g532;
                temp = 2.0 * temp1 * root54;
                self.d5421 = temp * f542 * g521;
                self.d5433 = temp * f543 * g533;
                self.xlamo = (self.mo + self.nodeo + self.nodeo - theta - theta) % TWOPI;
                self.xfact = self.mdot + self.dmdt + 2.0 * (self.nodedot + self.dnodt - rptim) - self.no_unkozai;
                *em = emo;
                emsq = emsqo;
            }

            // synchronous resonance terms
            if self.irez == 1 {
                let g200 = 1.0 + emsq * (-2.5 + 0.8125 * emsq);
                let g310 = 1.0 + 2.0 * emsq;
                let g300 = 1.0 + emsq * (-6.0 + 6.60937 * emsq);
                let f220 = 0.75 * (1.0 + cosim) * (1.0 + cosim);
                let f311 = 0.9375 * sinim * sinim * (1.0 + 3.0 * cosim) - 0.75 * (1.0 + cosim);
                let mut f330 = 1.0 + cosim;
                f330 = 1.875 * f330 * f330 * f330;
                self.del1 = 3.0 * *nm * *nm * aonv * aonv;
                self.del2 = 2.0 * self.del1 * f220 * g200 * q22;
                self.del3 = 3.0 * self.del1 * f330 * g300 * q33 * aonv;
                self.del1 = self.del1 * f311 * g310 * q31 * aonv;
                self.xlamo = (self.mo + self.nodeo + self.argpo - theta) % TWOPI;
                self.xfact = self.mdot + xpidot - rptim + self.dmdt + self.domdt + self.dnodt - self.no_unkozai;
            }

            // initialize the integrator
            self.xli = self.xlamo;
            self.xni = self.no_unkozai;
            self.atime = 0.0;
            *nm = self.no_unkozai + dndt;
        }
    }

    /// Deep-space secular effects and resonance integration (`dspace`).
    #[allow(clippy::too_many_arguments)]
    fn dspace(
        &mut self,
        t: f64,
        tc: f64,
        em: &mut f64,
        argpm: &mut f64,
        inclm: &mut f64,
        mm: &mut f64,
        nodem: &mut f64,
        nm: &mut f64,
    ) {
        let fasx2 = 0.13130908;
        let fasx4 = 2.8843198;
        let fasx6 = 0.37448087;
        let g22 = 5.7686396;
        let g32 = 0.95240898;
        let g44 = 1.8014998;
        let g52 = 1.0508330;
        let g54 = 4.4108898;
        let rptim = 4.37526908801129966e-3;
        let stepp = 720.0;
        let stepn = -720.0;
        let step2 = 259200.0;

        let theta = (self.gsto + tc * rptim) % TWOPI;
        *em += self.dedt * t;
        *inclm += self.didt * t;
        *argpm += self.domdt * t;
        *nodem += self.dnodt * t;
        *mm += self.dmdt * t;

        // update resonances: numerical (Euler-Maclaurin) integration
        if self.irez != 0 {
            let ft;
            // sgp4fix streamline check
            if self.atime == 0.0 || t * self.atime <= 0.0 || t.abs() < self.atime.abs() {
                self.atime = 0.0;
                self.xni = self.no_unkozai;
                self.xli = self.xlamo;
            }

            let delt = if t > 0.0 { stepp } else { stepn };

            let mut xndt;
            let mut xldot;
            let mut xnddt;
            loop {
                if self.irez != 2 {
                    // near-synchronous resonance terms
                    xndt = self.del1 * (self.xli - fasx2).sin()
                        + self.del2 * (2.0 * (self.xli - fasx4)).sin()
                        + self.del3 * (3.0 * (self.xli - fasx6)).sin();
                    xldot = self.xni + self.xfact;
                    xnddt = self.del1 * (self.xli - fasx2).cos()
                        + 2.0 * self.del2 * (2.0 * (self.xli - fasx4)).cos()
                        + 3.0 * self.del3 * (3.0 * (self.xli - fasx6)).cos();
                    xnddt *= xldot;
                } else {
                    // near-half-day resonance terms
                    let xomi = self.argpo + self.argpdot * self.atime;
                    let x2omi = xomi + xomi;
                    let x2li = self.xli + self.xli;
                    xndt = self.d2201 * (x2omi + self.xli - g22).sin()
                        + self.d2211 * (self.xli - g22).sin()
                        + self.d3210 * (xomi + self.xli - g32).sin()
                        + self.d3222 * (-xomi + self.xli - g32).sin()
                        + self.d4410 * (x2omi + x2li - g44).sin()
                        + self.d4422 * (x2li - g44).sin()
                        + self.d5220 * (xomi + self.xli - g52).sin()
                        + self.d5232 * (-xomi + self.xli - g52).sin()
                        + self.d5421 * (xomi + x2li - g54).sin()
                        + self.d5433 * (-xomi + x2li - g54).sin();
                    xldot = self.xni + self.xfact;
                    xnddt = self.d2201 * (x2omi + self.xli - g22).cos()
                        + self.d2211 * (self.xli - g22).cos()
                        + self.d3210 * (xomi + self.xli - g32).cos()
                        + self.d3222 * (-xomi + self.xli - g32).cos()
                        + self.d5220 * (xomi + self.xli - g52).cos()
                        + self.d5232 * (-xomi + self.xli - g52).cos()
                        + 2.0
                            * (self.d4410 * (x2omi + x2li - g44).cos()
                                + self.d4422 * (x2li - g44).cos()
                                + self.d5421 * (xomi + x2li - g54).cos()
                                + self.d5433 * (-xomi + x2li - g54).cos());
                    xnddt *= xldot;
                }

                // integrator
                if (t - self.atime).abs() >= stepp {
                    self.xli += xldot * delt + xndt * step2;
                    self.xni += xndt * delt + xnddt * step2;
                    self.atime += delt;
                } else {
                    ft = t - self.atime;
                    break;
                }
            }

            *nm = self.xni + xndt * ft + xnddt * ft * ft * 0.5;
            let xl = self.xli + xldot * ft + xndt * ft * ft * 0.5;
            if self.irez != 1 {
                *mm = xl - 2.0 * *nodem + 2.0 * theta;
            } else {
                *mm = xl - *nodem - *argpm + theta;
            }
            let dndt = *nm - self.no_unkozai;
            *nm = self.no_unkozai + dndt;
        }
    }

    /// Propagate to `tsince` minutes from epoch. Returns TEME (r km, v km/s),
    /// or the reference error code.
    pub fn propagate(&mut self, tsince: f64) -> Result<([f64; 3], [f64; 3]), u8> {
        let g = self.grav;
        let vkmpersec = g.radiusearthkm * g.xke / 60.0;

        self.t = tsince;
        self.error = error::OK;

        // update for secular gravity and atmospheric drag
        let xmdf = self.mo + self.mdot * self.t;
        let argpdf = self.argpo + self.argpdot * self.t;
        let nodedf = self.nodeo + self.nodedot * self.t;
        let mut argpm = argpdf;
        let mut mm = xmdf;
        let t2 = self.t * self.t;
        let mut nodem = nodedf + self.nodecf * t2;
        let mut tempa = 1.0 - self.cc1 * self.t;
        let mut tempe = self.bstar * self.cc4 * self.t;
        let mut templ = self.t2cof * t2;

        if !self.isimp {
            let delomg = self.omgcof * self.t;
            let delmtemp = 1.0 + self.eta * xmdf.cos();
            let delm = self.xmcof * (delmtemp * delmtemp * delmtemp - self.delmo);
            let temp = delomg + delm;
            mm = xmdf + temp;
            argpm = argpdf - temp;
            let t3 = t2 * self.t;
            let t4 = t3 * self.t;
            tempa = tempa - self.d2 * t2 - self.d3 * t3 - self.d4 * t4;
            tempe += self.bstar * self.cc5 * (mm.sin() - self.sinmao);
            templ += self.t3cof * t3 + t4 * (self.t4cof + self.t * self.t5cof);
        }

        let mut nm = self.no_unkozai;
        let mut em = self.ecco;
        let mut inclm = self.inclo;
        if self.deep_space {
            let tc = self.t;
            let t = self.t;
            self.dspace(t, tc, &mut em, &mut argpm, &mut inclm, &mut mm, &mut nodem, &mut nm);
        }

        if nm <= 0.0 {
            self.error = error::MEAN_MOTION;
            return Err(self.error);
        }
        let am = (g.xke / nm).powf(X2O3) * tempa * tempa;
        nm = g.xke / am.powf(1.5);
        em -= tempe;

        if !(-0.001..1.0).contains(&em) {
            self.error = error::ECCENTRICITY;
            return Err(self.error);
        }
        if em < 1.0e-6 {
            em = 1.0e-6;
        }
        mm += self.no_unkozai * templ;
        let mut xlm = mm + argpm + nodem;

        nodem %= TWOPI;
        argpm %= TWOPI;
        xlm %= TWOPI;
        mm = (xlm - argpm - nodem) % TWOPI;

        // recover singly averaged mean elements
        self.am = am;
        self.em = em;
        self.im = inclm;
        self.om_node = nodem;
        self.om_argp = argpm;
        self.mm = mm;
        self.nm = nm;

        let sinim = inclm.sin();
        let cosim = inclm.cos();

        // add lunar-solar periodics
        let mut ep = em;
        let mut xincp = inclm;
        let mut argpp = argpm;
        let mut nodep = nodem;
        let mut mp = mm;
        let mut sinip = sinim;
        let mut cosip = cosim;
        if self.deep_space {
            let t = self.t;
            self.dpper(t, &mut ep, &mut xincp, &mut nodep, &mut argpp, &mut mp);
            if xincp < 0.0 {
                xincp = -xincp;
                nodep += PI;
                argpp -= PI;
            }
            if !(0.0..=1.0).contains(&ep) {
                self.error = error::PERTURBED_ECCENTRICITY;
                return Err(self.error);
            }
        }

        // long period periodics
        if self.deep_space {
            sinip = xincp.sin();
            cosip = xincp.cos();
            self.aycof = -0.5 * g.j3oj2 * sinip;
            self.xlcof = if (cosip + 1.0).abs() > 1.5e-12 {
                -0.25 * g.j3oj2 * sinip * (3.0 + 5.0 * cosip) / (1.0 + cosip)
            } else {
                -0.25 * g.j3oj2 * sinip * (3.0 + 5.0 * cosip) / TEMP4
            };
        }
        let axnl = ep * argpp.cos();
        let mut temp = 1.0 / (am * (1.0 - ep * ep));
        let aynl = ep * argpp.sin() + temp * self.aycof;
        let xl = mp + argpp + nodep + temp * self.xlcof * axnl;

        // solve Kepler's equation
        let u = (xl - nodep) % TWOPI;
        let mut eo1 = u;
        let mut tem5: f64 = 9999.9;
        let mut ktr = 1;
        let mut sineo1 = 0.0;
        let mut coseo1 = 0.0;
        while tem5.abs() >= 1.0e-12 && ktr <= 10 {
            sineo1 = eo1.sin();
            coseo1 = eo1.cos();
            tem5 = 1.0 - coseo1 * axnl - sineo1 * aynl;
            tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
            if tem5.abs() >= 0.95 {
                tem5 = if tem5 > 0.0 { 0.95 } else { -0.95 };
            }
            eo1 += tem5;
            ktr += 1;
        }

        // short period preliminary quantities
        let ecose = axnl * coseo1 + aynl * sineo1;
        let esine = axnl * sineo1 - aynl * coseo1;
        let el2 = axnl * axnl + aynl * aynl;
        let pl = am * (1.0 - el2);
        if pl < 0.0 {
            self.error = error::SEMI_LATUS_RECTUM;
            return Err(self.error);
        }

        let rl = am * (1.0 - ecose);
        let rdotl = am.sqrt() * esine / rl;
        let rvdotl = pl.sqrt() / rl;
        let betal = (1.0 - el2).sqrt();
        temp = esine / (1.0 + betal);
        let sinu = am / rl * (sineo1 - aynl - axnl * temp);
        let cosu = am / rl * (coseo1 - axnl + aynl * temp);
        let mut su = sinu.atan2(cosu);
        let sin2u = (cosu + cosu) * sinu;
        let cos2u = 1.0 - 2.0 * sinu * sinu;
        temp = 1.0 / pl;
        let temp1 = 0.5 * g.j2 * temp;
        let temp2 = temp1 * temp;

        // update for short period periodics
        if self.deep_space {
            let cosisq = cosip * cosip;
            self.con41 = 3.0 * cosisq - 1.0;
            self.x1mth2 = 1.0 - cosisq;
            self.x7thm1 = 7.0 * cosisq - 1.0;
        }
        let mrt = rl * (1.0 - 1.5 * temp2 * betal * self.con41) + 0.5 * temp1 * self.x1mth2 * cos2u;
        su -= 0.25 * temp2 * self.x7thm1 * sin2u;
        let xnode = nodep + 1.5 * temp2 * cosip * sin2u;
        let xinc = xincp + 1.5 * temp2 * cosip * sinip * cos2u;
        let mvt = rdotl - nm * temp1 * self.x1mth2 * sin2u / g.xke;
        let rvdot = rvdotl + nm * temp1 * (self.x1mth2 * cos2u + 1.5 * self.con41) / g.xke;

        // orientation vectors
        let sinsu = su.sin();
        let cossu = su.cos();
        let snod = xnode.sin();
        let cnod = xnode.cos();
        let sini = xinc.sin();
        let cosi = xinc.cos();
        let xmx = -snod * cosi;
        let xmy = cnod * cosi;
        let ux = xmx * sinsu + cnod * cossu;
        let uy = xmy * sinsu + snod * cossu;
        let uz = sini * sinsu;
        let vx = xmx * cossu - cnod * sinsu;
        let vy = xmy * cossu - snod * sinsu;
        let vz = sini * cossu;

        let r = [
            mrt * ux * g.radiusearthkm,
            mrt * uy * g.radiusearthkm,
            mrt * uz * g.radiusearthkm,
        ];
        let v = [
            (mvt * ux + rvdot * vx) * vkmpersec,
            (mvt * uy + rvdot * vy) * vkmpersec,
            (mvt * uz + rvdot * vz) * vkmpersec,
        ];

        // sgp4fix for decaying satellites
        if mrt < 1.0 {
            self.error = error::DECAYED;
            return Err(self.error);
        }
        Ok((r, v))
    }

    /// Propagate to a Julian date (UTC).
    #[inline]
    pub fn propagate_jd(&mut self, jd: f64) -> Result<([f64; 3], [f64; 3]), u8> {
        self.propagate((jd - self.epoch_jd) * 1440.0)
    }

    /// Mean motion in rev/day (Kozai), for display.
    pub fn mean_motion_rev_per_day(&self) -> f64 {
        self.no_kozai * 1440.0 / (2.0 * PI)
    }

    /// Mean semi-major axis in km (from un-Kozai'd mean motion).
    pub fn semi_major_axis_km(&self) -> f64 {
        self.a * self.grav.radiusearthkm
    }

    pub fn radius_earth_km(&self) -> f64 {
        self.grav.radiusearthkm
    }
}
